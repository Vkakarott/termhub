import type { PrismaClient } from '../prisma.js';
import type { ChatStandingGrant as PrismaRow } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { GRANT_LIST_MAX, type GrantCursor } from './chat-grants.js';

export const STANDING_GRANT_KINDS = ['open_tab', 'close_tab', 'start_agent', 'board', 'terminal'] as const;
export type StandingGrantKind = (typeof STANDING_GRANT_KINDS)[number];
export const isStandingGrantKind = (v: unknown): v is StandingGrantKind => (STANDING_GRANT_KINDS as readonly string[]).includes(v as string);

/** "Liberar sem prazo": a standing "yes" for one user, one project and one kind, until revoked. */
export interface ChatStandingGrant {
  id: string;
  user_id: string;
  project_id: string;
  kind: StandingGrantKind;
  conversation_id: string | null;
  source_action_id: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface ChatStandingGrantWithConversation extends ChatStandingGrant {
  conversation_project_id: string | null;
  conversation_archived: boolean;
}

/** Rows whose `kind` the code does not know are skipped by the readers below (`mapKnown`). */
const map = (g: PrismaRow): ChatStandingGrant | null =>
  isStandingGrantKind(g.kind)
    ? { id: g.id, user_id: g.userId, project_id: g.projectId, kind: g.kind, conversation_id: g.conversationId, source_action_id: g.sourceActionId, created_at: g.createdAt.toISOString(), revoked_at: g.revokedAt?.toISOString() ?? null, revoked_by: g.revokedBy }
    : null;
const mapKnown = (rows: PrismaRow[]) => rows.flatMap((r) => { const m = map(r); return m ? [m] : []; });

/** "Liberar sem prazo" — not conversation-bound, unlike `ChatGrantsRepository`/`ChatProjectGrantsRepository`:
 * one row per user + project + kind, trusted everywhere until revoked. Every method is keyed by `user_id`
 * (server-derived, never a client value), so scoping never needs to go through an owning conversation. */
export class ChatStandingGrantsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * Trusts a project + kind for a user with no expiry. The previous active row for the same triple is
   * revoked in the same transaction — granting again is how re-granting after a revoke works.
   */
  async grant(input: { user_id: string; project_id: string; kind: StandingGrantKind; conversation_id?: string | null; source_action_id?: string | null }, now = new Date()): Promise<ChatStandingGrant> {
    const row = await this.db.$transaction(async (tx) => {
      await tx.chatStandingGrant.updateMany({ where: { userId: input.user_id, projectId: input.project_id, kind: input.kind, revokedAt: null }, data: { revokedAt: now, revokedBy: input.user_id } });
      return tx.chatStandingGrant.create({ data: { id: newId(), userId: input.user_id, projectId: input.project_id, kind: input.kind, conversationId: input.conversation_id ?? null, sourceActionId: input.source_action_id ?? null, createdAt: now } });
    });
    return map(row)!;
  }

  async findActive(userId: string, projectId: string, kind: StandingGrantKind): Promise<ChatStandingGrant | undefined> {
    const r = await this.db.chatStandingGrant.findFirst({ where: { userId, projectId, kind, revokedAt: null } });
    return r ? (map(r) ?? undefined) : undefined;
  }

  async listActive(userId: string, projectId?: string | null): Promise<ChatStandingGrant[]> {
    return mapKnown(await this.db.chatStandingGrant.findMany({ where: { userId, revokedAt: null, ...(projectId ? { projectId } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
  }

  /** The active grant a confirmation card created, if any — for the injected sentence. */
  async findActiveBySourceAction(userId: string, actionId: string): Promise<ChatStandingGrant | undefined> {
    const r = await this.db.chatStandingGrant.findFirst({ where: { userId, sourceActionId: actionId, revokedAt: null } });
    return r ? (map(r) ?? undefined) : undefined;
  }

  async findByIdForUser(id: string, userId: string): Promise<ChatStandingGrant | undefined> {
    const r = await this.db.chatStandingGrant.findFirst({ where: { id, userId } });
    return r ? (map(r) ?? undefined) : undefined;
  }

  /** "Revogar". Undefined when it matched nothing: wrong id, another user's, or already revoked. */
  async revoke(id: string, userId: string, now = new Date()): Promise<ChatStandingGrant | undefined> {
    const { count } = await this.db.chatStandingGrant.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: now, revokedBy: userId } });
    if (count === 0) return undefined;
    const r = await this.db.chatStandingGrant.findUnique({ where: { id } });
    return r ? (map(r) ?? undefined) : undefined;
  }

  /** Every standing grant of one user. `active` returns what is in force; `ended` is the history,
   * newest first, paged by `(created_at, id)` so rows sharing a timestamp are neither skipped nor repeated. */
  async listForUser(userId: string, opts: { state: 'active' | 'ended'; cursor?: GrantCursor | null; limit: number }): Promise<{ grants: ChatStandingGrantWithConversation[]; next: GrantCursor | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), GRANT_LIST_MAX);
    const state = opts.state === 'active' ? { revokedAt: null } : { revokedAt: { not: null } };
    const cursor = opts.state === 'ended' ? opts.cursor : null;
    const after = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.created_at) } }, { createdAt: new Date(cursor.created_at), id: { lt: cursor.id } }] } : {};
    const rows = await this.db.chatStandingGrant.findMany({ where: { AND: [{ userId }, state, after] }, include: { conversation: { select: { projectId: true, archivedAt: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      grants: page.flatMap((r) => { const m = map(r); return m ? [{ ...m, conversation_project_id: r.conversation?.projectId ?? null, conversation_archived: r.conversation?.archivedAt != null }] : []; }),
      next: opts.state === 'ended' && rows.length > limit && last ? { created_at: last.createdAt.toISOString(), id: last.id } : null,
    };
  }
}
