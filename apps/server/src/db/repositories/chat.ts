import type { PrismaClient } from '../prisma.js';
import { Prisma, type ChatConversation as PrismaConversation, type ChatMessage as PrismaMessage } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type ChatRole = 'user' | 'assistant';

export interface ChatConversation {
  id: string;
  user_id: string;
  title: string | null;
  cli_session_id: string | null;
  model: string | null;
  review_mode: boolean;
  last_message_at: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: ChatRole;
  text: string;
  usage: unknown | null;
  error_code: string | null;
  created_at: string;
}

const mapConversation = (c: PrismaConversation): ChatConversation => ({
  id: c.id,
  user_id: c.userId,
  title: c.title,
  cli_session_id: c.cliSessionId,
  model: c.model,
  review_mode: c.reviewMode,
  last_message_at: c.lastMessageAt?.toISOString() ?? null,
  created_at: c.createdAt.toISOString(),
});

const mapMessage = (m: PrismaMessage): ChatMessage => ({
  id: m.id,
  conversation_id: m.conversationId,
  role: m.role as ChatRole,
  text: m.text,
  usage: m.usage ?? null,
  error_code: m.errorCode,
  created_at: m.createdAt.toISOString(),
});

export class ChatRepository {
  constructor(private db: PrismaClient) {}

  /**
   * v1 keeps one conversation per user, enforced by a partial unique index on `user_id` (see the
   * migration) so two concurrent first loads (e.g. two browser tabs) can't both create one. The
   * common path is a single SELECT; only a lost race falls back to create-then-re-read.
   */
  async getOrCreateForUser(userId: string): Promise<ChatConversation> {
    const existing = await this.db.chatConversation.findFirst({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (existing) return mapConversation(existing);
    try {
      const created = await this.db.chatConversation.create({ data: { id: newId(), userId } });
      return mapConversation(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.db.chatConversation.findFirst({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        if (winner) return mapConversation(winner);
      }
      throw err;
    }
  }

  async setCliSession(id: string, sessionId: string | null): Promise<void> {
    await this.db.chatConversation.update({ where: { id }, data: { cliSessionId: sessionId } });
  }

  async addMessage(input: { conversation_id: string; role: ChatRole; text: string; usage?: unknown; error_code?: string | null }): Promise<ChatMessage> {
    const [message] = await this.db.$transaction([
      this.db.chatMessage.create({
        data: {
          id: newId(),
          conversationId: input.conversation_id,
          role: input.role,
          text: input.text,
          usage: (input.usage ?? null) as never,
          errorCode: input.error_code ?? null,
        },
      }),
      this.db.chatConversation.update({ where: { id: input.conversation_id }, data: { lastMessageAt: new Date() } }),
    ]);
    return mapMessage(message);
  }

  async updateMessage(id: string, patch: { text?: string; usage?: unknown; error_code?: string | null }): Promise<ChatMessage> {
    const row = await this.db.chatMessage.update({
      where: { id },
      data: {
        ...(patch.text === undefined ? {} : { text: patch.text }),
        ...(patch.usage === undefined ? {} : { usage: patch.usage as never }),
        ...(patch.error_code === undefined ? {} : { errorCode: patch.error_code }),
      },
    });
    return mapMessage(row);
  }

  /**
   * The newest `limit` messages, returned oldest-first. The window must be anchored at the end of
   * the conversation, not at its start: taking the *oldest* rows means that past `limit` messages
   * the payload never again contains the message the user just sent or its answer — the screen
   * would freeze on ancient history with no error and no way out.
   */
  async listMessages(conversationId: string, limit = 200): Promise<ChatMessage[]> {
    const rows = await this.db.chatMessage.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    return rows.reverse().map(mapMessage);
  }
}
