import type { PrismaClient } from '../prisma.js';
import type { ApiToken as PrismaApiToken } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { toScopes, type ApiTokenScope } from '../../auth/api-tokens.js';

/** A personal API token as routes see it: never the hash, never the plain token. */
export interface ApiToken {
  id: string;
  user_id: string;
  name: string;
  scopes: ApiTokenScope[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** One MCP tool call: metadata only (never typed text, screen content or prompts). */
export interface ApiTokenEventInput {
  token_id: string;
  tool: string;
  machine_id?: string | null;
  project_id?: string | null;
  tab_id?: string | null;
  ok: boolean;
  error_code?: string | null;
  duration_ms: number;
}

const TOUCH_INTERVAL_MS = 60_000;

const mapApiToken = (t: PrismaApiToken): ApiToken => ({
  id: t.id,
  user_id: t.userId,
  name: t.name,
  scopes: toScopes(t.scopes),
  expires_at: t.expiresAt?.toISOString() ?? null,
  last_used_at: t.lastUsedAt?.toISOString() ?? null,
  revoked_at: t.revokedAt?.toISOString() ?? null,
  created_at: t.createdAt.toISOString(),
});

const activeWhere = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

export class ApiTokensRepository {
  constructor(private db: PrismaClient) {}

  async listByUser(userId: string): Promise<ApiToken[]> {
    const rows = await this.db.apiToken.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map(mapApiToken);
  }

  async countActive(userId: string, now = new Date()): Promise<number> {
    return this.db.apiToken.count({ where: { userId, ...activeWhere(now) } });
  }

  async create(userId: string, input: { name: string; scopes: ApiTokenScope[]; expiresAt: Date | null }, tokenHash: string): Promise<ApiToken> {
    const t = await this.db.apiToken.create({
      data: { id: newId(), userId, name: input.name, scopes: input.scopes, expiresAt: input.expiresAt, tokenHash },
    });
    return mapApiToken(t);
  }

  /** Revokes the user's token (idempotent: a second call keeps the first timestamp). Undefined when it isn't theirs. */
  async revoke(id: string, userId: string): Promise<ApiToken | undefined> {
    await this.db.apiToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    const t = await this.db.apiToken.findFirst({ where: { id, userId } });
    return t ? mapApiToken(t) : undefined;
  }

  /** The token for a presented secret's hash, when it is neither revoked nor expired. */
  async findActiveByHash(tokenHash: string, now = new Date()): Promise<ApiToken | undefined> {
    const t = await this.db.apiToken.findFirst({ where: { tokenHash, ...activeWhere(now) } });
    return t ? mapApiToken(t) : undefined;
  }

  /** Records a use; skips the write when the last one is under a minute old. */
  async touchLastUsed(id: string, now = new Date()): Promise<void> {
    await this.db.apiToken.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: new Date(now.getTime() - TOUCH_INTERVAL_MS) } }] },
      data: { lastUsedAt: now },
    });
  }

  async recordEvent(e: ApiTokenEventInput): Promise<void> {
    await this.db.apiTokenEvent.create({
      data: {
        id: newId(),
        tokenId: e.token_id,
        tool: e.tool,
        machineId: e.machine_id ?? null,
        projectId: e.project_id ?? null,
        tabId: e.tab_id ?? null,
        ok: e.ok,
        errorCode: e.error_code ?? null,
        durationMs: e.duration_ms,
      },
    });
  }

  async purgeEventsBefore(cutoff: Date): Promise<number> {
    const r = await this.db.apiTokenEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
