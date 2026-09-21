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

/** The CLI says this when --resume names a session the account's config dir does not have. */
const isMissingSession = (e: unknown) => /No conversation found|session ID/i.test(e instanceof Error ? e.message : '');

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
      let failure: string | null = null;

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
            usage = frame.usage ?? null;
            if (frame.session_id && frame.session_id !== conversation.cli_session_id) await this.deps.repos.chat.setCliSession(conversation.id, frame.session_id);
          } else if (frame.type === 'error') {
            failure = frame.message;
          }
        }
      };

      // Minting can fail (see mintConciergeToken's note: the previous token is already revoked by
      // the time create() might throw). Either way the failure must land on the assistant message,
      // not escape send() and leave an empty bubble with no explanation.
      let token: string | undefined;
      try {
        token = await mintConciergeToken(this.deps.repos, user.id, ['read']);
      } catch (e) {
        failure = e instanceof Error ? e.message : 'falha ao gerar o token do concierge';
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
        } catch (e) {
          // A resume that the account cannot honour is not a failure: start a fresh session once.
          if (input.resume && isMissingSession(e)) {
            const fresh = { ...input, resume: false, session_id: randomUUID() };
            await this.deps.repos.chat.setCliSession(conversation.id, null);
            try {
              await consume(fresh);
            } catch (again) {
              failure = again instanceof Error ? again.message : 'runner failed';
            }
          } else {
            failure = e instanceof Error ? e.message : 'runner failed';
          }
        }
      }

      answer = await this.deps.repos.chat.updateMessage(answer.id, { text: collected, usage, error_code: failure ? 'RUNNER_FAILED' : null });
      chatBus.publish({ type: 'message', user_id: user.id, message: answer });
      return answer;
    } finally {
      this.running.delete(conversation.id);
    }
  }
}
