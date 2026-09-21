import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatConversation, ChatMessage } from '../db/repositories/chat.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { User } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { parseFrame, type ChatFailureReason } from './stream.js';
import { mintConciergeToken } from './token.js';

/** What a stored failure says. The reason codes come from the container's closed set, so a failed
 * row explains itself: CLI_REJECTED is our own flags being refused, MISSING_SESSION is a session the
 * account no longer has, RUN_FAILED is the CLI failing on its own terms. */
export type ChatErrorCode = 'TOKEN_FAILED' | 'RUNNER_FAILED' | 'MISSING_SESSION' | 'CLI_REJECTED' | 'RUN_FAILED' | null;

const codeForReason = (reason?: ChatFailureReason): ChatErrorCode =>
  reason === 'missing_session' ? 'MISSING_SESSION' : reason === 'cli_rejected' ? 'CLI_REJECTED' : reason === 'run_failed' ? 'RUN_FAILED' : 'RUNNER_FAILED';

export interface RunnerInput {
  session_id: string;
  resume: boolean;
  text: string;
  config_dir: string;
  model?: string | null;
  token: string;
}
export interface RunnerClient {
  run(input: RunnerInput): AsyncIterable<string>;
}

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
 * other it may have made — the same ids it used to make the call in the first place. */
const targetDescription = (action: ChatAction): string => {
  if (action.tab_id) return `aba ${action.tab_id}`;
  if (action.project_id) return `projeto ${action.project_id}`;
  if (action.machine_id) return `máquina ${action.machine_id}`;
  return 'sem alvo específico';
};

/**
 * The re-injection (spec §5, Task 5): a fixed pt-BR sentence the server composes, never the model's
 * own words and never a tool result. It names the tool and its target so the model can re-issue the
 * exact call that was gated (an approval) or drop it for good (a denial) — the model is never asked
 * to guess which of its proposals the user was answering.
 *
 * When no CLI session is alive (Review Focus 2: an approval can arrive an hour later, or the CLI may
 * have dropped the session), `send` already starts a fresh run on its own — this only adds the line
 * that tells the user so in the chat, instead of a fresh run happening silently.
 */
const injectionText = (action: ChatAction, freshSession: boolean): string => {
  const target = targetDescription(action);
  const sessionNote = freshSession
    ? ' A sessão de trabalho anterior não está mais disponível, então esta é uma nova sessão, sem o histórico da conversa anterior.'
    : '';
  return action.status === 'denied'
    ? `O usuário recusou: ${action.tool} em ${target}.${sessionNote} Não faça essa ação: explique ao usuário o que ficou sem fazer e, se fizer sentido, proponha uma alternativa.`
    : `O usuário autorizou: ${action.tool} em ${target}.${sessionNote} Siga com essa ação.`;
};

export class ChatService {
  /** One run per conversation: two `claude -p` processes on the same --session-id would race. */
  private running = new Set<string>();

  constructor(private deps: { repos: Repositories; runner: RunnerClient; configDirs: { primary: string; secondary?: string } }) {}

  conversationFor(user: User): Promise<ChatConversation> {
    return this.deps.repos.chat.getOrCreateForUser(user.id);
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
   */
  async resumeAfterDecision(user: User, action: ChatAction): Promise<ChatMessage> {
    const conversation = await this.conversationFor(user);
    return this.send(user, injectionText(action, conversation.cli_session_id === null));
  }

  async send(user: User, text: string): Promise<ChatMessage> {
    const conversation = await this.conversationFor(user);
    if (this.running.has(conversation.id)) throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY');
    this.running.add(conversation.id);
    try {
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
        for await (const line of this.deps.runner.run(run)) {
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
        token = await mintConciergeToken(this.deps.repos, user.id, ['read']);
      } catch {
        errorCode = 'TOKEN_FAILED';
      }

      if (token !== undefined) {
        const sessionId = conversation.cli_session_id ?? randomUUID();
        const input: RunnerInput = {
          session_id: sessionId,
          resume: conversation.cli_session_id !== null,
          text,
          config_dir: this.deps.configDirs.primary,
          model: conversation.model,
          token,
        };

        try {
          await consume(input);
          if (!sawDone) errorCode = 'RUNNER_FAILED';
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
            if (!sawDone) errorCode = 'RUNNER_FAILED';
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
    }
  }
}
