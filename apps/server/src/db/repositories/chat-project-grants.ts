import type { PrismaClient } from '../prisma.js';
import type { ChatProjectGrant as PrismaRow } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { GRANT_LIST_MAX, GRANT_TTL_MS, type GrantCursor } from './chat-grants.js';

/** A standing "yes" for the board tools in one project, in one conversation. */
export interface ChatProjectGrant {
  id: string;
  conversation_id: string;
  project_id: string;
  source_action_id: string | null;
  granted_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface ChatProjectGrantWithConversation extends ChatProjectGrant {
  conversation_project_id: string | null;
  conversation_archived: boolean;
}

const map = (g: PrismaRow): ChatProjectGrant => ({
  id: g.id,
  conversation_id: g.conversationId,
  project_id: g.projectId,
  source_action_id: g.sourceActionId,
  granted_by: g.grantedBy,
  created_at: g.createdAt.toISOString(),
  expires_at: g.expiresAt.toISOString(),
  revoked_at: g.revokedAt?.toISOString() ?? null,
  revoked_by: g.revokedBy,
});

/** Same scoping rules as `ChatGrantsRepository`: conversation-keyed methods trust a server-derived id,
 * id-keyed methods a client sends filter by the owning conversation's `user_id` in SQL. */
export class ChatProjectGrantsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * Trusts a project for the board tools in a conversation ("Permitir sempre neste projeto"). The
   * previous grant for the same pair — active or merely expired, both hold the partial unique slot —
   * is revoked in the same transaction, so granting again is how the 24 h restarts.
   */
  async grant(input: { conversation_id: string; project_id: string; source_action_id?: string | null; granted_by: string }, now = new Date()): Promise<ChatProjectGrant> {
    const row = await this.db.$transaction(async (tx) => {
      await tx.chatProjectGrant.updateMany({ where: { conversationId: input.conversation_id, projectId: input.project_id, revokedAt: null }, data: { revokedAt: now, revokedBy: input.granted_by } });
      return tx.chatProjectGrant.create({
        data: { id: newId(), conversationId: input.conversation_id, projectId: input.project_id, sourceActionId: input.source_action_id ?? null, grantedBy: input.granted_by, createdAt: now, expiresAt: new Date(now.getTime() + GRANT_TTL_MS) },
      });
    });
    return map(row);
  }

  async findActive(conversationId: string, projectId: string, now = new Date()): Promise<ChatProjectGrant | undefined> {
    const row = await this.db.chatProjectGrant.findFirst({ where: { conversationId, projectId, revokedAt: null, expiresAt: { gt: now } } });
    return row ? map(row) : undefined;
  }

  async listActive(conversationId: string, now = new Date()): Promise<ChatProjectGrant[]> {
    const rows = await this.db.chatProjectGrant.findMany({ where: { conversationId, revokedAt: null, expiresAt: { gt: now } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(map);
  }

  /** The active grant a confirmation card created, if any — for the injected sentence. */
  async findActiveBySourceAction(conversationId: string, actionId: string, now = new Date()): Promise<ChatProjectGrant | undefined> {
    const row = await this.db.chatProjectGrant.findFirst({ where: { conversationId, sourceActionId: actionId, revokedAt: null, expiresAt: { gt: now } } });
    return row ? map(row) : undefined;
  }

  /** Scoped through the owning conversation's `user_id`: another user's grant and no grant at all are
   * the same `undefined`. */
  async findByIdForUser(id: string, userId: string): Promise<ChatProjectGrant | undefined> {
    const row = await this.db.chatProjectGrant.findFirst({ where: { id, conversation: { userId } } });
    return row ? map(row) : undefined;
  }

  /** "Revogar". Undefined when it matched nothing: wrong id, another user's, or already revoked. */
  async revoke(id: string, userId: string, now = new Date()): Promise<ChatProjectGrant | undefined> {
    const { count } = await this.db.chatProjectGrant.updateMany({ where: { id, revokedAt: null, conversation: { userId } }, data: { revokedAt: now, revokedBy: userId } });
    if (count === 0) return undefined;
    const row = await this.db.chatProjectGrant.findUnique({ where: { id } });
    return row ? map(row) : undefined;
  }

  /** "Nova conversa" ends the conversation, and with it every project grant it held. */
  async revokeForConversation(conversationId: string, now = new Date()): Promise<number> {
    const { count } = await this.db.chatProjectGrant.updateMany({ where: { conversationId, revokedAt: null }, data: { revokedAt: now, revokedBy: null } });
    return count;
  }

  /** Every project grant of one user, across all their conversations, scoped by the owning
   * conversation's `user_id` in SQL. `active` returns what is in force; `ended` is the history, newest
   * first, paged by `(created_at, id)` so rows sharing a timestamp are neither skipped nor repeated. */
  async listForUser(userId: string, opts: { state: 'active' | 'ended'; cursor?: GrantCursor | null; limit: number }, now = new Date()): Promise<{ grants: ChatProjectGrantWithConversation[]; next: GrantCursor | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), GRANT_LIST_MAX);
    const state = opts.state === 'active' ? { revokedAt: null, expiresAt: { gt: now } } : { OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] };
    const cursor = opts.state === 'ended' ? opts.cursor : null;
    const after = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.created_at) } }, { createdAt: new Date(cursor.created_at), id: { lt: cursor.id } }] } : {};
    const rows = await this.db.chatProjectGrant.findMany({
      where: { AND: [{ conversation: { userId } }, state, after] },
      include: { conversation: { select: { projectId: true, archivedAt: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      grants: page.map((r) => ({ ...map(r), conversation_project_id: r.conversation.projectId, conversation_archived: r.conversation.archivedAt !== null })),
      next: opts.state === 'ended' && rows.length > limit && last ? { created_at: last.createdAt.toISOString(), id: last.id } : null,
    };
  }
}
