import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatConversation, ChatMessage } from '../db/repositories/chat.js';
import type { User } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { parseFrame } from './stream.js';
import { mintConciergeToken } from './token.js';

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

export class ChatService {
  /** One run per conversation: two `claude -p` processes on the same --session-id would race. */
  private running = new Set<string>();

  constructor(private deps: { repos: Repositories; runner: RunnerClient; configDirs: { primary: string; secondary?: string } }) {}

  conversationFor(user: User): Promise<ChatConversation> {
    return this.deps.repos.chat.getOrCreateForUser(user.id);
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
      let errorCode: 'TOKEN_FAILED' | 'RUNNER_FAILED' | null = null;

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
            errorCode = 'RUNNER_FAILED';
            if (frame.reason === 'missing_session') missingSession = true;
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
