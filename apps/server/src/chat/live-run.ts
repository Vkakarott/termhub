import { randomUUID } from 'node:crypto';
import { STREAM_END_INPUT_LINE, streamUserMessageLine } from '@termhub/agent-protocol';
import type { ChatMessage, ChatRepository } from '../db/repositories/chat.js';
import type { ChatAction, ChatActionsRepository } from '../db/repositories/chat-actions.js';
import type { StoredTurn } from '../db/repositories/chat-live-runs.js';
import type { ChatSubagent, ChatSubagentsRepository } from '../db/repositories/chat-subagents.js';
import { chatBus } from './bus.js';
import { actionClass } from './gate.js';
import { failureLabel, type RunStream } from './service.js';
import { codeForReason, parseFrame, type ChatErrorCode } from './stream.js';
import { subagentOrigins } from './subagent-origin.js';
import { toSubagentView } from './subagent-view.js';

/** The `request_id` of a `stop_task` control request is this plus the subagent's id: how its
 *  `control_response` is matched back to the subagent it was about. */
export const STOP_REQUEST_PREFIX = 'stop-';

/** One message of the person's in a streamed run, from the moment it is written until it is answered. */
export interface LiveTurn {
  /** The uuid written with the message; the CLI replays it when this turn starts. */
  uuid: string;
  /** Written to the CLI: the person's text, with any tab-question context in front. */
  text: string;
  /** Null only for a turn resumed after a restart whose question row is gone. */
  question: ChatMessage | null;
  answer: ChatMessage;
  /** Settles `done` of the `StartedRun` this turn was handed back as. */
  settle: { resolve(m: ChatMessage): void; reject(e: unknown): void };
}

/** A turn being answered: the person's, or one the CLI started on its own (a subagent's notification). */
interface Answering {
  turn: LiveTurn | null;
  answer: ChatMessage;
  collected: string;
  usage: unknown;
  /** Turns of the person's the CLI folded into this one before it said anything (see `turn_started`
   *  in `consume`): their own answers were deleted, and they settle with this turn's final message. */
  merged: LiveTurn[];
}

export interface LiveRunDeps {
  userId: string;
  conversationId: string;
  /** The CLI session this run resumes (or will name), updated from the CLI's own frames. */
  sessionId: string | null;
  chat: Pick<ChatRepository, 'addMessage' | 'updateMessage' | 'deleteMessage' | 'setCliSession'>;
  /** The conversation's subagents (spec 2026-09-26 panel §5.3), kept from the CLI's task frames. */
  subagents: Pick<ChatSubagentsRepository, 'start' | 'setStatus' | 'interruptRunning'>;
  chatActions: Pick<ChatActionsRepository, 'setSubagentByToolUse'>;
  /** Re-publishes the confirmation of actions the gate proposed before the stream said which
   *  subagent made them (ChatService supplies it). */
  describeLate?: (actions: ChatAction[]) => Promise<void>;
  /** Fire-and-forget: the open turns changed (persisted so another instance can resume them). */
  onTurnsChanged?: (turns: StoredTurn[]) => void;
}

/**
 * One long-lived `claude` process of a conversation, with streamed input (spec 2026-09-26 §5.7): turns
 * go in as lines, answers come back matched by the replayed uuid, a turn the CLI starts on its own gets
 * a message of its own, and the input ends once nothing is running. It never takes the conversation's
 * lock nor mints a token — `ChatService` does, and owns this object for as long as the process lives.
 */
export class LiveRun {
  private waiting: LiveTurn[] = [];
  private current: Answering | null = null;
  private background = 0;
  private stream: RunStream | null = null;
  private inputOpen = true;
  private ended = 0;
  private session: string | null;
  /** Whether the process being read replayed a message yet (see the safety net at `done`). */
  private replayed = false;
  /** The newest question this run took: re-published to make screens re-read when a row is dropped. */
  private lastQuestion: ChatMessage | null = null;
  /** Subagents this run started, by the CLI's task id and by the Task tool_use_id that launched them. */
  private subagentsByTask = new Map<string, ChatSubagent>();
  private subagentsByToolUse = new Map<string, ChatSubagent>();
  /** Silent lines not replayed yet (uuid → text): the input stays open for them, and a process
   *  started (or restarted) before their replay gets them first. */
  private notes = new Map<string, string>();
  /** Subagents a `stop_task` was written for, until its answer or their final status. */
  private stopping = new Set<string>();

  constructor(private deps: LiveRunDeps) {
    this.session = deps.sessionId;
  }

  /** Whether a message can still be injected into this process. */
  get accepting(): boolean {
    return this.inputOpen;
  }
  get endedTurns(): number {
    return this.ended;
  }
  get sessionId(): string | null {
    return this.session;
  }

  /** Takes a turn: written now to the live process, or kept for `initialText` before it starts. False
   *  when the input is closed (or the channel refused the line): the caller queues it for the next run. */
  add(turn: LiveTurn): boolean {
    if (!this.inputOpen) return false;
    this.waiting.push(turn);
    if (this.stream?.write && !this.stream.write(streamUserMessageLine(turn.text, turn.uuid))) {
      this.waiting.pop();
      return false;
    }
    if (turn.question) this.lastQuestion = turn.question;
    this.turnsChanged();
    return true;
  }

  /** A line with no question row and no waiting request (a decision or a tab's answer told to the
   *  concierge): whatever the CLI says to it becomes a message of its own. Counted as pending until
   *  its replay, so the input does not close under it. False when the input is closed. */
  addNote(text: string): boolean {
    if (!this.inputOpen) return false;
    const uuid = randomUUID();
    if (this.stream?.write && !this.stream.write(streamUserMessageLine(text, uuid))) return false;
    this.notes.set(uuid, text);
    return true;
  }

  /** Asks the CLI to stop one background subagent. False when the input is closed or the line was
   *  refused. The row's status and its event are the caller's; a refusal comes back as a
   *  `control_response` and is rolled back here. */
  stopTask(taskId: string, subagentId: string): boolean {
    if (!this.inputOpen || !this.stream?.write) return false;
    const line = JSON.stringify({ type: 'control_request', request_id: STOP_REQUEST_PREFIX + subagentId, request: { subtype: 'stop_task', task_id: taskId } });
    if (!this.stream.write(line)) return false;
    this.stopping.add(subagentId);
    return true;
  }

  /** A stop that failed (refused by the CLI, or never answered in time): back to running, and every
   *  open screen says it could not cancel. A no-op once the stop settled either way. Never throws. */
  async rollbackStop(subagentId: string): Promise<void> {
    if (!this.stopping.delete(subagentId)) return;
    const { userId, conversationId } = this.deps;
    await this.bookkeeping(async () => {
      const row = await this.deps.subagents.setStatus(subagentId, 'running');
      if (row) this.remember(row);
    });
    chatBus.publish({ type: 'subagent_cancel_failed', user_id: userId, conversation_id: conversationId, subagent_id: subagentId });
  }

  /** The turns still open, in order: the one being answered (and those folded into it), then those waiting. */
  storedTurns(): StoredTurn[] {
    const cur = this.current;
    return [...(cur?.turn ? [cur.turn] : []), ...(cur?.merged ?? []), ...this.waiting].map((t) => ({ question_id: t.question?.id ?? null, answer_id: t.answer.id, text: t.text }));
  }

  /** The first input of a process: every note not yet replayed, then every turn not yet answered, one line each. */
  initialText(): string {
    const notes = [...this.notes].map(([uuid, text]) => `${streamUserMessageLine(text, uuid)}\n`);
    return [...notes, ...this.waiting.map((t) => `${streamUserMessageLine(t.text, t.uuid)}\n`)].join('');
  }

  /** Reads one process to its end. Throws what the stream throws (a setup failure is the caller's). */
  async consume(stream: RunStream): Promise<{ code: ChatErrorCode; missingSession: boolean }> {
    this.stream = stream;
    this.replayed = false;
    let code: ChatErrorCode = null;
    let missingSession = false;
    try {
      for await (const line of stream) {
        const frame = parseFrame(line);
        if (!frame) continue;
        if (frame.type === 'turn_started') {
          if (this.notes.delete(frame.uuid)) {
            // A note: a turn that already said something (or one the CLI started on its own) ends
            // here, and what the CLI says next goes to a message of its own (`answering`). A person's
            // turn that has said nothing yet stays current: the reply is still its answer.
            this.replayed = true;
            const cur = this.current;
            if (cur && !(cur.turn && cur.collected === '')) await this.finish(cur, null);
            continue;
          }
          const i = this.waiting.findIndex((t) => t.uuid === frame.uuid);
          if (i === -1) continue;
          this.replayed = true;
          // A message written while a turn is running can be folded INTO that turn by the CLI (Claude
          // Code 2.1.283: the replay arrives mid tool-use, before any result, and one result then answers
          // both). A person's turn that has said nothing yet is merged into the new one: its empty answer
          // goes and it settles with the new turn's message. One that has text keeps it as its answer,
          // and so does a turn the CLI started on its own.
          const [turn] = this.waiting.splice(i, 1);
          const prev = this.current;
          if (prev?.turn && prev.collected === '') {
            this.current = { turn, answer: turn.answer, collected: '', usage: null, merged: [...prev.merged, prev.turn] };
            await this.deps.chat.deleteMessage(prev.answer.id);
            // Re-publishing a question makes every open screen re-read and drop the deleted answer.
            const question = prev.turn.question ?? this.lastQuestion;
            if (question) chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: question });
          } else {
            if (prev) await this.finish(prev, null);
            this.current = { turn, answer: turn.answer, collected: '', usage: null, merged: [] };
          }
          this.turnsChanged();
        } else if (frame.type === 'text') {
          const a = await this.answering();
          a.collected += frame.delta;
          chatBus.publish({ type: 'delta', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: a.answer.id, delta: frame.delta });
        } else if (frame.type === 'action') {
          const a = await this.answering();
          chatBus.publish({ type: 'action', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: a.answer.id, tool: frame.tool, tool_use_id: frame.tool_use_id, args: frame.args });
        } else if (frame.type === 'action_result') {
          if (this.current) chatBus.publish({ type: 'action_result', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: this.current.answer.id, tool_use_id: frame.tool_use_id, ok: frame.ok });
        } else if (frame.type === 'done') {
          await this.saveSession(frame.session_id);
          if (this.current) {
            this.current.usage = frame.usage ?? null;
            await this.finish(this.current, null);
          }
          // A turn ended and this process never replayed a message: the CLI does not echo the uuids,
          // so no waiting turn can ever be matched. They fail now instead of waiting for the kill.
          if (!this.replayed && (this.waiting.length > 0 || this.notes.size > 0)) await this.failWaiting('RUN_FAILED');
          this.endInputIfIdle();
        } else if (frame.type === 'error') {
          await this.saveSession(frame.session_id);
          if (frame.turn_ended) {
            if (this.current) await this.finish(this.current, 'RUN_FAILED');
            this.endInputIfIdle();
          } else {
            code = codeForReason(frame.reason);
            if (frame.reason === 'missing_session') missingSession = true;
          }
        } else if (frame.type === 'background') {
          this.background = frame.count;
          this.endInputIfIdle();
        } else if (frame.type === 'subagent_started') {
          await this.bookkeeping(async () => {
            const row = await this.deps.subagents.start({ conversation_id: this.deps.conversationId, task_id: frame.task_id, tool_use_id: frame.tool_use_id, description: frame.description, subagent_type: frame.subagent_type });
            this.remember(row);
          });
        } else if (frame.type === 'subagent_status') {
          const known = this.subagentsByTask.get(frame.task_id);
          if (!known) continue;
          this.stopping.delete(known.id);
          await this.bookkeeping(async () => {
            const row = await this.deps.subagents.setStatus(known.id, frame.status);
            if (row) this.remember(row);
          });
        } else if (frame.type === 'subagent_tool') {
          const parent = this.subagentsByToolUse.get(frame.parent_tool_use_id);
          if (!parent) continue;
          // The gate reads this back when the MCP call arrives after this frame; for one that arrived
          // first, the action it already stored is bound here and its confirmation re-published.
          subagentOrigins.remember(frame.tool_use_id, { conversationId: this.deps.conversationId, subagentId: parent.id });
          if (actionClass(frame.tool, {}) === 'read') continue;
          await this.bookkeeping(async () => {
            const bound = await this.deps.chatActions.setSubagentByToolUse(this.deps.conversationId, frame.tool_use_id, parent.id);
            if (bound.length) await this.deps.describeLate?.(bound);
          });
        } else if (frame.type === 'control_response') {
          if (!frame.request_id.startsWith(STOP_REQUEST_PREFIX)) continue;
          const id = frame.request_id.slice(STOP_REQUEST_PREFIX.length);
          // Accepted: the task's final status follows as its own frame.
          if (this.stopping.has(id) && !frame.ok) await this.rollbackStop(id);
        }
      }
    } finally {
      // Whatever the CLI was running dies with it: nothing will ever report their final status.
      await this.bookkeeping(async () => {
        for (const row of await this.deps.subagents.interruptRunning(this.deps.conversationId)) this.remember(row);
      });
      this.stopping.clear();
      this.stream = null;
      this.inputOpen = false;
    }
    return { code, missingSession };
  }

  /** A fresh session after `missing_session`: every open turn waits again, its partial text dropped. */
  async restart(): Promise<void> {
    const cur = this.current;
    this.current = null;
    if (cur) {
      // A merged turn's answer row was deleted: it waits again with a new, empty one.
      for (const t of cur.merged) {
        t.answer = await this.deps.chat.addMessage({ conversation_id: this.deps.conversationId, role: 'assistant', text: '' });
        chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: t.answer });
      }
      this.waiting.unshift(...cur.merged, ...(cur.turn ? [cur.turn] : []));
    }
    for (const t of this.waiting) chatBus.publish({ type: 'reset', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: t.answer.id });
    this.background = 0;
    this.inputOpen = true;
    this.session = null;
    this.turnsChanged();
    await this.deps.chat.setCliSession(this.deps.conversationId, null);
  }

  /** The process is over: every turn still open is stored with `code`. */
  async failOpen(code: ChatErrorCode): Promise<void> {
    this.inputOpen = false;
    const open: Answering[] = [...(this.current ? [this.current] : []), ...this.waiting.splice(0).map((t) => ({ turn: t, answer: t.answer, collected: '', usage: null, merged: [] }))];
    // Every turn is settled even when storing one fails (`finish` rejects that one); the first failure
    // is rethrown once all of them are done, so no web request is left waiting forever.
    let failure: { error: unknown } | null = null;
    for (const a of open) {
      try {
        await this.finish(a, code);
      } catch (e) {
        failure ??= { error: e };
      }
    }
    if (failure) throw failure.error;
  }

  /** Nothing ran and nothing will (a setup failure): the answers go, every open turn rejects. */
  async abandon(err: unknown): Promise<void> {
    this.inputOpen = false;
    // Merged turns have no answer row left: they only reject.
    const merged = this.current?.merged ?? [];
    const open = [...(this.current?.turn ? [this.current.turn] : []), ...this.waiting.splice(0)];
    this.current = null;
    for (const t of merged) t.settle.reject(err);
    let failure: { error: unknown } | null = null;
    for (const t of open) {
      try {
        await this.deps.chat.deleteMessage(t.answer.id);
        // Re-publishing the question makes every open screen re-read, which is how they learn the
        // answer row is gone (the bus has no "removed" event).
        if (t.question) chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: t.question });
      } catch (e) {
        failure ??= { error: e };
      } finally {
        // Rejected either way: the turn never ran, and its request must not wait forever.
        t.settle.reject(err);
      }
    }
    if (failure) throw failure.error;
  }

  /** The turn frames belong to; a turn the CLI started on its own gets a new assistant message. */
  private async answering(): Promise<Answering> {
    if (this.current) return this.current;
    const answer = await this.deps.chat.addMessage({ conversation_id: this.deps.conversationId, role: 'assistant', text: '' });
    chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: answer });
    this.current = { turn: null, answer, collected: '', usage: null, merged: [] };
    return this.current;
  }

  private async finish(a: Answering, code: ChatErrorCode): Promise<void> {
    try {
      await this.finishTurn(a, code);
    } finally {
      this.turnsChanged();
    }
  }

  private async finishTurn(a: Answering, code: ChatErrorCode): Promise<void> {
    if (this.current === a) this.current = null;
    // A turn the CLI started on its own that said nothing (a tool call, then the next replay or its
    // result): an empty "ok" row reads as a failed answer, so it goes. Nobody waits on it.
    if (a.turn === null && a.collected === '' && code === null) {
      this.ended += 1;
      await this.deps.chat.deleteMessage(a.answer.id);
      // Re-publishing a question makes every open screen re-read and drop the deleted row.
      if (this.lastQuestion) chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: this.lastQuestion });
      return;
    }
    const settles = [...a.merged, ...(a.turn ? [a.turn] : [])].map((t) => t.settle);
    let final: ChatMessage;
    try {
      final = await this.deps.chat.updateMessage(a.answer.id, { text: a.collected, usage: a.usage, error_code: code });
      this.ended += 1 + a.merged.length;
      chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: final });
      chatBus.publish({ type: 'run_finished', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: final.id, ok: code === null, error_code: code });
    } catch (e) {
      // The turn is already out of `current` and `waiting`: nothing else could ever settle it.
      for (const st of settles) st.reject(e);
      throw e;
    }
    for (const st of settles) st.resolve(final);
  }

  private async saveSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId || sessionId === this.session) return;
    this.session = sessionId;
    await this.deps.chat.setCliSession(this.deps.conversationId, sessionId);
  }

  /** Fails every waiting turn with `code` and closes the input: nothing written here will be answered. */
  private async failWaiting(code: ChatErrorCode): Promise<void> {
    this.inputOpen = false;
    this.notes.clear();
    this.stream?.write?.(STREAM_END_INPUT_LINE);
    let failure: { error: unknown } | null = null;
    for (const t of this.waiting.splice(0)) {
      try {
        await this.finish({ turn: t, answer: t.answer, collected: '', usage: null, merged: [] }, code);
      } catch (e) {
        failure ??= { error: e };
      }
    }
    if (failure) throw failure.error;
  }

  /** Nothing to answer and nothing in the background: end the input. The CLI still runs whatever it
   *  has (a notification turn that is on its way), and a message that comes later goes to the next run. */
  private endInputIfIdle(): void {
    if (!this.inputOpen || this.current || this.waiting.length > 0 || this.notes.size > 0 || this.background > 0) return;
    this.inputOpen = false;
    this.stream?.write?.(STREAM_END_INPUT_LINE);
  }

  /** Keeps a subagent row by task and by launching tool_use_id, and tells every open screen. */
  private remember(row: ChatSubagent): void {
    this.subagentsByTask.set(row.task_id, row);
    this.subagentsByToolUse.set(row.tool_use_id, row);
    chatBus.publish({ type: 'subagent', user_id: this.deps.userId, conversation_id: this.deps.conversationId, subagent: toSubagentView(row) });
  }

  /** Subagent bookkeeping never breaks the stream nor fails a turn: a failure is logged by its label. */
  private async bookkeeping(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      console.error('chat: subagent bookkeeping failed', { conversation_id: this.deps.conversationId, error: failureLabel(err) });
    }
  }

  private turnsChanged(): void {
    try {
      this.deps.onTurnsChanged?.(this.storedTurns());
    } catch (err) {
      console.error('chat: live run turns could not be reported', { conversation_id: this.deps.conversationId, error: failureLabel(err) });
    }
  }
}
