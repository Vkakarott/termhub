import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatConversation, ChatMessage } from '../db/repositories/chat.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import { describeActions } from '../db/repositories/chat-actions-view.js';
import type { User } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { hostFailure, resolveHost, type HostAgents, type HostChoice } from './host.js';
import { parseFrame, type ChatFailureReason } from './stream.js';
import { mintConciergeToken } from './token.js';

/**
 * What a stored failure says. Every label a runner can end a run with becomes a code of its own —
 * `Uppercase<ChatFailureReason>`, derived from the one list in `stream.ts`, so a new reason reaches
 * the row (and the screen) without anyone remembering to extend a mapping here. CLI_REJECTED is our
 * own flags being refused, MISSING_SESSION a session the account no longer has, CLI_MISSING a machine
 * with no `claude` installed, HOST_GONE the machine going away mid-run. The two that are not a
 * runner's label: TOKEN_FAILED (the server could not even mint a credential) and RUNNER_FAILED (the
 * stream ended with nothing said about why).
 */
export type ChatErrorCode = 'TOKEN_FAILED' | 'RUNNER_FAILED' | Uppercase<ChatFailureReason> | null;

const codeForReason = (reason?: ChatFailureReason): ChatErrorCode => (reason ? (reason.toUpperCase() as Uppercase<ChatFailureReason>) : 'RUNNER_FAILED');

export interface RunnerInput {
  session_id: string;
  resume: boolean;
  text: string;
  /** The account the run uses: a `CLAUDE_CONFIG_DIR` on the host machine, or `null` for that
   *  machine's own default login (an `ai_account` row with no `config_dir`). */
  config_dir: string | null;
  model?: string | null;
  token: string;
}
export interface RunnerClient {
  run(input: RunnerInput): AsyncIterable<string>;
}

/** How long a proposed action waits for the user's decision before it is nobody's question anymore —
 * and, since an approval nobody consumed is just as stale, how long a "yes" stays good (the gate reads
 * this same constant for `APPROVAL_HOLDS_MS`). Kept in step with `mintConciergeToken`'s own TTL_MS: a
 * token outlives every action minted under it. */
export const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The hourly timer's other half (app.ts, next to `authService.purgeExpired()`): an open row must not
 * sit open forever — it would keep blocking the same proposal's idempotency key and keep showing as an
 * open question on every reload. Both ways of being open age out, each from its own clock: a question
 * the user never answered from when it was asked, an approval no run ever came back to consume from
 * when it was given (see `expireOlderThan`). An approval that is merely slow to be re-injected is well
 * inside the window; one still here a day later is one nobody will ever use, and the gate would
 * otherwise honour it indefinitely.
 *
 * A standalone function, not a `ChatService` method: it only ever needs `repos`, and keeping it out of
 * the class means the hourly timer can call it without constructing a runner or config dirs it has no
 * use for, and it can be unit-tested the same way.
 */
export async function purgeExpiredActions(repos: Repositories, now = new Date()): Promise<number> {
  return repos.chatActions.expireOlderThan(new Date(now.getTime() - ACTION_TTL_MS));
}

/**
 * What a failure is called, never what it says. Our own errors (`HttpError`, `ControlError`) and the
 * database driver's carry a `code`; anything else is named by its class. A message is deliberately out
 * of reach: a rejected write carries the rejected data, so logging one would put the injected sentence
 * or the proposed command in a log line — the one thing that must never be logged (spec §7.1).
 */
const failureLabel = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return err instanceof Error ? err.name : typeof err;
};

/**
 * Errors that mean "the chat could not even be attempted" rather than "the answer failed": the
 * concierge is not configured on this server (503) or did not accept the request at all (502).
 * They escape `send()` so the route answers with that status and its pt-BR message, instead of
 * every message forever being stored as a run that died — retrying a missing configuration never
 * helps, and the page has nothing to say about it.
 */
const isSetupFailure = (e: unknown): e is HttpError =>
  e instanceof HttpError && (e.code === 'CONCIERGE_DISABLED' || e.code === 'CONCIERGE_FAILED');

/** What the action targets, in the one line the model needs to tell this proposal apart from any
 * other it may have made — the tool name and the target ids the model's own original call carried
 * (`args.tab_id`/`project_id`/`machine_id`, capped and id-shaped by the gate before they were ever
 * stored — see `targetOf` in gate-runtime.ts), never a tool result and never free-form argument text. */
const targetDescription = (action: ChatAction): string => {
  if (action.tab_id) return `aba ${action.tab_id}`;
  if (action.project_id) return `projeto ${action.project_id}`;
  if (action.machine_id) return `máquina ${action.machine_id}`;
  return 'sem alvo específico';
};

/**
 * The re-injection (spec §5, Task 5): a fixed pt-BR sentence the server composes — the tool name, the
 * target ids and, on a fresh session, the approved proposal itself; never a tool result — so the model
 * can re-issue the exact call that was gated (an approval) or drop it for good (a denial), without
 * being asked to guess which of its proposals the user was answering or to read the user's own words.
 *
 * When no CLI session is alive (Review Focus 2: an approval can arrive an hour later, or the CLI may
 * have dropped the session), `send` already starts a fresh run on its own — this adds the line that
 * tells the user so in the chat, instead of a fresh run happening silently, and the proposal the lost
 * transcript would otherwise have carried (`approvedProposal`).
 */
const injectionText = (action: ChatAction, freshSession: boolean, summary?: string): string => {
  const target = targetDescription(action);
  const sessionNote = freshSession
    ? ' A sessão de trabalho anterior não está mais disponível, então esta é uma nova sessão, sem o histórico da conversa anterior.'
    : '';
  if (action.status === 'denied')
    return `O usuário recusou: ${action.tool} em ${target}.${sessionNote} Não faça essa ação: explique ao usuário o que ficou sem fazer e, se fizer sentido, proponha uma alternativa.`;
  return `O usuário autorizou: ${action.tool} em ${target}.${sessionNote}${freshSession ? approvedProposal(action, summary) : ''} Siga com essa ação.`;
};

/**
 * What the user approved, spelled out — for a fresh session only. Without a transcript, "o usuário
 * autorizou: send_input em aba t1" names the tool and the target and nothing else: the model cannot
 * know *what text to type*, so it either asks again or invents different arguments, which hash to a
 * different idempotency key and raise a second question for an action already authorised, while the
 * approved row it never used lingers.
 *
 * Both halves are the user's own proposal, which §7.1 explicitly permits storing and showing, and
 * neither is a tool result: `summary` is the very sentence the card the user answered showed them, and
 * `args` is the call the concierge itself proposed — the exact bytes the gate hashed, so re-issuing
 * them lands on the approved row instead of opening a new question. A resumed session gets none of
 * this: its transcript already carries the context, and the shorter sentence is the better one there.
 */
const approvedProposal = (action: ChatAction, summary?: string): string =>
  `${summary ? ` A ação autorizada foi: ${summary}.` : ''} Refaça exatamente esta chamada, com estes argumentos e nenhuma alteração: ${JSON.stringify(action.args)}.`;

export class ChatService {
  /** One run per conversation: two `claude -p` processes on the same --session-id would race. */
  private running = new Set<string>();
  /** Decisions whose `markInjected` failed in this process — see `drainNextDecision`. In memory on
   * purpose: the row itself is untouched, so a restart tries it again with a healthy database. */
  private unmarkable = new Set<string>();

  constructor(
    private deps: {
      repos: Repositories;
      /** The registry `resolveHost` reads: which of the user's machines is connected, and what its
       *  agent understands. */
      agents: HostAgents;
      /** The runner for one host machine — `agentRunner` in production. A function, not a client:
       *  which machine runs a conversation is decided per send, by `resolveHost`. */
      runnerFor: (machineId: string) => RunnerClient;
    },
  ) {}

  conversationFor(user: User): Promise<ChatConversation> {
    return this.deps.repos.chat.getOrCreateForUser(user.id);
  }

  /** The host pair for this user, as the screen shows it (`GET /api/chat`) and as `send` requires it.
   *  One place decides it; nothing here re-derives any part of it. */
  hostFor(user: User): Promise<HostChoice> {
    return resolveHost({ repos: this.deps.repos, agents: this.deps.agents }, user);
  }

  /**
   * Answers the user's decision on a gated action by re-injecting it into the same CLI session, so
   * the model re-issues the call (an approval, which Task 4's `allow` branch then executes) or drops
   * it (a denial). This is exactly one message: `decide()` already made sure the caller cannot reach
   * here twice for the same row (ruling R9 — the second click of the same decision gets a 409 in the
   * route before this is ever called), so nothing here retries or de-dupes on its own.
   *
   * Reuses `send` wholesale rather than duplicating its streaming, retry and locking logic: the
   * injected sentence is just another user turn, so the busy lock, the fresh-session fallback and the
   * bus events all behave exactly as they do for anything the user types.
   *
   * If another run already holds the conversation's lock, `send` throws `HttpError(409, CHAT_BUSY)`
   * before `beforeRun` ever gets to mark the row injected — the decision stays `approved`/`denied`
   * with `injected_at` still null, exactly the state `findNextToInject` looks for. The route (fix
   * round 2) turns that specific 409 into a 200: the decision is already durably recorded, so telling
   * the client "conflict" would be a lie. `drainNextDecision` picks the row up once the busy run's own
   * `send` call releases the lock, so the two paths — inject now, or inject once the lock frees up —
   * both go through this same `beforeRun` marking, and cannot diverge (fix round 2, point 4).
   */
  async resumeAfterDecision(user: User, action: ChatAction): Promise<ChatMessage> {
    const conversation = await this.conversationFor(user);
    return this.send(user, await this.injectionFor(user, action, conversation.cli_session_id === null), {
      beforeRun: () => this.deps.repos.chatActions.markInjected(action.id),
    });
  }

  /**
   * The sentence a decision is injected as. Only a fresh session pays for the enriched summary — three
   * owner-scoped batched reads, resolved by the very function that built the card the user answered
   * (`describeActions`, so a foreign id in the proposal still resolves to nothing here) — because only
   * a fresh session has lost the transcript that would otherwise say what was approved.
   */
  private async injectionFor(user: User, action: ChatAction, freshSession: boolean): Promise<string> {
    if (!freshSession || action.status === 'denied') return injectionText(action, freshSession);
    const [card] = await describeActions(this.deps.repos, [action], user.id);
    return injectionText(action, freshSession, card.summary);
  }

  /**
   * Picks up exactly one decided-but-uninjected action for this conversation, if any, once a run's
   * lock is released. This is how a decision that lost the race to a busy run in `resumeAfterDecision`
   * still gets injected, without the client that clicked approve/deny ever retrying anything.
   *
   * Injects at most one: the run this starts is itself a `send` call whose own completion calls this
   * again, so a backlog of N decisions drains over N completions, one at a time, in the order they
   * were decided — never by looping over the whole backlog inside a single call (which is the
   * "recursing" the fix round asked to avoid: unbounded depth in one call instead of one step per
   * natural completion).
   *
   * One user has exactly one conversation (the same v1 assumption `gate-runtime.ts` relies on), so
   * reusing the caller's own `user` for the injected run is safe — there is no other user it could be.
   *
   * Never lets a failure here reach its own caller: it is scheduled from a `finally` block, so it must
   * never turn a clean, already-finished run into a thrown error over an unrelated decision's failed
   * retry (a lock grabbed by an unrelated message in the moment between the lookup and the injected
   * `send` call, a concierge outage). It is still swallowed at the call site, and it leaves a trace
   * before it is: a failure between marking a row injected and storing the injected message loses that
   * decision for good, and a loss nobody can find afterwards is exactly the failure this branch spent a
   * round ruling out. The trace is metadata only — the conversation, the action, and the failure's label
   * — never the injected sentence, the arguments, the prompt or the token.
   */
  private async drainNextDecision(user: User): Promise<void> {
    let conversationId: string | null = null;
    let actionId: string | null = null;
    try {
      const conversation = await this.conversationFor(user);
      conversationId = conversation.id;
      const next = await this.deps.repos.chatActions.findNextToInject(conversation.id, [...this.unmarkable]);
      if (!next) return;
      actionId = next.id;
      await this.send(user, await this.injectionFor(user, next, conversation.cli_session_id === null), {
        // Marking is what makes the injection at-most-once, so a row it failed on stays uninjected and
        // would be picked again by the drain this very failure schedules — a spin on one row for as long
        // as the database keeps refusing. Remembering it here is what stops that; the row is not lost,
        // the next process (or `GET /api/chat`'s trail) still shows the decision the user gave.
        beforeRun: async () => {
          try {
            await this.deps.repos.chatActions.markInjected(next.id);
          } catch (err) {
            this.unmarkable.add(next.id);
            throw err;
          }
        },
      });
    } catch (err) {
      console.error('chat: a decided action could not be re-injected', { conversation_id: conversationId, action_id: actionId, error: failureLabel(err) });
    }
  }

  async send(user: User, text: string, opts?: { beforeRun?: () => Promise<void> }): Promise<ChatMessage> {
    const conversation = await this.conversationFor(user);
    // Which machine and which account, before the lock is taken and before a single row is written: a
    // host that cannot run is not a failed answer, it is a message that was never sent. Storing the
    // question and an empty assistant bubble for it would leave the screen waiting on an answer nobody
    // is producing, and the person would have to guess why — so this throws, carrying the reason as
    // its code (see `hostFailure`). Deliberately not a fallback to the operator's container (spec §3).
    //
    // Resolved *before* the busy check, not between it and `running.add`: every await in between is a
    // window in which a second message passes the check and starts a second run on the same session.
    const host = await this.hostFor(user);
    if (host.kind !== 'ready') throw hostFailure(host);
    if (this.running.has(conversation.id)) throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY');
    const runner = this.deps.runnerFor(host.machine.id);
    this.running.add(conversation.id);
    try {
      // The host this run uses is the host this conversation has, and from here on it says so: a
      // conversation whose machine was auto-picked (one candidate, nothing stored) is otherwise
      // indistinguishable from one whose stored host was unenrolled out from under a live session, and
      // those two need opposite screens — see `pinHostMachine`. Only ever fills a null, so it can
      // never move a host the user chose; after the lock, so it only ever records a run that happens.
      await this.deps.repos.chat.pinHostMachine(conversation.id, host.machine.id);

      // Only ever set by a decision's re-injection, and only reached once the lock above is actually
      // held — marking the row happens here, never before the lock check, so a busy run can never
      // mark a decision injected that it never actually sent (fix round 2).
      if (opts?.beforeRun) await opts.beforeRun();

      const question = await this.deps.repos.chat.addMessage({ conversation_id: conversation.id, role: 'user', text });
      chatBus.publish({ type: 'message', user_id: user.id, message: question });

      let answer = await this.deps.repos.chat.addMessage({ conversation_id: conversation.id, role: 'assistant', text: '' });
      chatBus.publish({ type: 'message', user_id: user.id, message: answer });

      let collected = '';
      let usage: unknown = null;
      /** Whether a `done` frame was seen for the run currently being consumed. A stream that ends
       * (the container closes the body, e.g. an OOM kill) without one must not be mistaken for a
       * clean finish: the text collected so far looks complete but isn't, and cli_session_id would
       * silently stay unset. */
      let sawDone = false;
      /** Set by an error frame whose reason says the CLI does not have the session we asked it to
       * resume. It is the container that classifies this (it is the only side that sees the CLI's
       * stderr, which never travels): the app reads the frame's `reason`, never an error's text. */
      let missingSession = false;
      /** Set once something went wrong. Distinct from a runner failure: the run never started
       * because the server itself could not mint a credential (nothing the account can fix by
       * being switched), vs. a run that started and died mid-stream (often account/quota, which
       * account fallback can act on). */
      let errorCode: ChatErrorCode = null;

      const consume = async (run: RunnerInput) => {
        for await (const line of runner.run(run)) {
          const frame = parseFrame(line);
          if (!frame) continue;
          if (frame.type === 'text') {
            collected += frame.delta;
            chatBus.publish({ type: 'delta', user_id: user.id, message_id: answer.id, delta: frame.delta });
          } else if (frame.type === 'action') {
            chatBus.publish({ type: 'action', user_id: user.id, message_id: answer.id, tool: frame.tool, tool_use_id: frame.tool_use_id, args: frame.args });
          } else if (frame.type === 'action_result') {
            chatBus.publish({ type: 'action_result', user_id: user.id, message_id: answer.id, tool_use_id: frame.tool_use_id, ok: frame.ok });
          } else if (frame.type === 'done') {
            sawDone = true;
            usage = frame.usage ?? null;
            if (frame.session_id && frame.session_id !== conversation.cli_session_id) await this.deps.repos.chat.setCliSession(conversation.id, frame.session_id);
          } else if (frame.type === 'error') {
            // The reason is the container's closed-set classification, so a failure is diagnosable
            // from the stored row alone: CLI_REJECTED means our own flags were refused, which no
            // amount of retrying fixes. Without this, every failure looked the same and finding the
            // cause meant probing the container by hand.
            errorCode = codeForReason(frame.reason);
            if (frame.reason === 'missing_session') missingSession = true;
            // A failed run still leaves its session, and the whole transcript, on disk: this server
            // generated the uuid and passed it as --session-id, so there is nothing unknown about
            // it. Dropping it here would make the next message mint a fresh uuid and silently lose
            // the thread — the user's follow-up would arrive at a concierge with no context. The
            // genuinely gone session is the `missing_session` case, cleared below.
            if (frame.session_id && frame.session_id !== conversation.cli_session_id) await this.deps.repos.chat.setCliSession(conversation.id, frame.session_id);
          }
        }
      };

      // Minting can fail (see mintConciergeToken's note: the previous token is already revoked by
      // the time create() might throw). Either way the failure must land on the assistant message,
      // not escape send() and leave an empty bubble with no explanation.
      let token: string | undefined;
      try {
        // Wide scopes are safe here only because mintConciergeToken always pairs them with
        // `gated: true` — every write this token can attempt still stops at the chat's gate.
        token = await mintConciergeToken(this.deps.repos, user.id, ['read', 'tasks', 'terminals']);
      } catch {
        errorCode = 'TOKEN_FAILED';
      }

      if (token !== undefined) {
        const sessionId = conversation.cli_session_id ?? randomUUID();
        const input: RunnerInput = {
          session_id: sessionId,
          resume: conversation.cli_session_id !== null,
          text,
          config_dir: host.configDir,
          model: conversation.model,
          token,
        };

        try {
          await consume(input);
          // Only when nothing has already said why: an error frame's own reason (cli_missing above
          // all, the likeliest first failure of a chat on someone's own machine) is the whole point of
          // carrying a label from the machine to the screen, and overwriting it here with the generic
          // "a resposta não terminou" threw it away one step before it was read.
          if (!sawDone && errorCode === null) errorCode = 'RUNNER_FAILED';
        } catch (e) {
          if (isSetupFailure(e)) {
            // Nothing ran and nothing will: drop the empty assistant row instead of leaving a
            // bubble that would say "pensando…" for ever, and let the status reach the browser.
            await this.deps.repos.chat.deleteMessage(answer.id);
            // Re-publishing the question makes every open tab re-read the conversation, which is
            // how they learn the assistant row is gone (the bus has no "removed" event).
            chatBus.publish({ type: 'message', user_id: user.id, message: question });
            throw e;
          }
          // The stream itself broke (the container closed the socket, the deadline aborted it):
          // there is no frame to read a reason from, so this can only be a plain failure.
          errorCode = 'RUNNER_FAILED';
        }

        // A resume the account cannot honour is not a failure: start a fresh session once. The
        // signal is the error frame's reason, the only thing the container can tell us about the
        // CLI's stderr without forwarding it.
        if (input.resume && missingSession) {
          const fresh = { ...input, resume: false, session_id: randomUUID() };
          // The failed attempt may have streamed partial text before dying; that text (and
          // whatever the browser already rendered for it) belongs to a session the CLI has
          // discarded, so both sides must start the answer over.
          collected = '';
          sawDone = false;
          missingSession = false;
          errorCode = null;
          chatBus.publish({ type: 'reset', user_id: user.id, message_id: answer.id });
          await this.deps.repos.chat.setCliSession(conversation.id, null);
          try {
            await consume(fresh);
            if (!sawDone && errorCode === null) errorCode = 'RUNNER_FAILED';
          } catch (e) {
            if (isSetupFailure(e)) {
              await this.deps.repos.chat.deleteMessage(answer.id);
              chatBus.publish({ type: 'message', user_id: user.id, message: question });
              throw e;
            }
            errorCode = 'RUNNER_FAILED';
          }
        }
      }

      answer = await this.deps.repos.chat.updateMessage(answer.id, { text: collected, usage, error_code: errorCode });
      chatBus.publish({ type: 'message', user_id: user.id, message: answer });
      return answer;
    } finally {
      this.running.delete(conversation.id);
      // The lock is free: if a decision was recorded while it was held (fix round 2) and could not
      // be injected immediately, this is where it finally gets its turn. Scheduled, never awaited:
      // the drain starts a CLI run of its own, whose completion schedules another — awaiting it would
      // hold this request open across every run the backlog needs (a user who approves two actions
      // during one run would keep their original `POST /api/chat/messages` open across three runs, and
      // nginx would cut the client while the runs carried on). The answer this request came for is
      // already stored and published, so the client loses nothing by being answered now: the injected
      // runs reach it over the chat's own stream, exactly as they do for a decision taken while idle.
      // `drainNextDecision` logs its own failure (metadata only) and resolves; the `catch` is the last
      // guard that nothing from it can ever become this run's outcome or an unhandled rejection.
      void this.drainNextDecision(user).catch(() => {});
    }
  }
}
