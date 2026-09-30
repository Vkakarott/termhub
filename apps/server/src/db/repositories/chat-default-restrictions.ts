import type { PrismaClient } from '../prisma.js';
import { DEFAULT_ALLOW_KINDS, isDefaultAllowKind, type DefaultAllowKind } from '../../chat/gate.js';

/** What a user took out of the chat's default allowances (TER-627). Keyed by the server-derived user
 * id only; a row whose `kind` the code no longer knows is ignored. */
export class ChatDefaultRestrictionsRepository {
  constructor(private db: PrismaClient) {}

  async listForUser(userId: string): Promise<Set<DefaultAllowKind>> {
    const rows = await this.db.chatDefaultRestriction.findMany({ where: { userId }, select: { kind: true } });
    return new Set(rows.map((r) => r.kind).filter(isDefaultAllowKind));
  }

  /** Every default kind with whether it is on for this user, in `DEFAULT_ALLOW_KINDS` order. */
  async stateForUser(userId: string): Promise<{ kind: DefaultAllowKind; allowed: boolean }[]> {
    const restricted = await this.listForUser(userId);
    return DEFAULT_ALLOW_KINDS.map((kind) => ({ kind, allowed: !restricted.has(kind) }));
  }

  /** Turns one default on (deletes the restriction) or off (records it). Idempotent both ways. */
  async setAllowed(userId: string, kind: DefaultAllowKind, allowed: boolean): Promise<void> {
    if (allowed) await this.db.chatDefaultRestriction.deleteMany({ where: { userId, kind } });
    else await this.db.chatDefaultRestriction.upsert({ where: { userId_kind: { userId, kind } }, create: { userId, kind }, update: {} });
  }
}
