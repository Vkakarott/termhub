import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ApiTokensRepository } from './api-tokens.js';

const DAY = 24 * 60 * 60 * 1000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ApiTokensRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ApiTokensRepository;
  let userId: string;
  let otherId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ApiTokensRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    otherId = newId();
    await db.user.createMany({
      data: [
        { id: userId, email: `${userId}@test.local`, name: 'me' },
        { id: otherId, email: `${otherId}@test.local`, name: 'other' },
      ],
    });
    return async () => {
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); // cascades tokens and events
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const make = (owner: string, over: { name?: string; expiresAt?: Date | null; hash?: string } = {}) =>
    repo.create(owner, { name: over.name ?? 't', scopes: ['read', 'tasks'], expiresAt: over.expiresAt ?? null }, over.hash ?? newId(32));

  it('creates a token, maps it without the hash, and lists only the owner\'s, newest first', async () => {
    const first = await make(userId, { name: 'first' });
    // created_at has millisecond precision: age the first token so the order is deterministic
    await db.apiToken.update({ where: { id: first.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const second = await make(userId, { name: 'second' });
    await make(otherId, { name: 'foreign' });

    expect(first).toMatchObject({ user_id: userId, name: 'first', scopes: ['read', 'tasks'], expires_at: null, last_used_at: null, revoked_at: null });
    expect(Object.keys(first)).not.toContain('token_hash');
    expect(Object.keys(first)).not.toContain('tokenHash');
    expect((await repo.listByUser(userId)).map((t) => t.id)).toEqual([second.id, first.id]);
  });

  it('revokes only the owner\'s token, once', async () => {
    const mine = await make(userId);
    expect(await repo.revoke(mine.id, otherId)).toBeUndefined();
    expect(await repo.revoke('missing', userId)).toBeUndefined();

    const revoked = await repo.revoke(mine.id, userId);
    expect(revoked?.revoked_at).not.toBeNull();
    const again = await repo.revoke(mine.id, userId);
    expect(again?.revoked_at).toBe(revoked?.revoked_at);
  });

  it('counts only active tokens: not revoked, not expired', async () => {
    await make(userId);
    await make(userId, { expiresAt: new Date(Date.now() + DAY) });
    await make(userId, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = await make(userId);
    await repo.revoke(revoked.id, userId);
    await make(otherId);

    expect(await repo.countActive(userId)).toBe(2);
  });

  it('finds an active token by hash, and never a revoked, expired or unknown one', async () => {
    const active = await make(userId, { hash: 'h-active' });
    await make(userId, { hash: 'h-expired', expiresAt: new Date(Date.now() - 1000) });
    const revoked = await make(userId, { hash: 'h-revoked' });
    await repo.revoke(revoked.id, userId);

    expect((await repo.findActiveByHash('h-active'))?.id).toBe(active.id);
    expect(await repo.findActiveByHash('h-expired')).toBeUndefined();
    expect(await repo.findActiveByHash('h-revoked')).toBeUndefined();
    expect(await repo.findActiveByHash('h-unknown')).toBeUndefined();
  });

  it('touches last_used_at at most once a minute', async () => {
    const t = await make(userId);
    const t0 = new Date();
    await repo.touchLastUsed(t.id, t0);
    await repo.touchLastUsed(t.id, new Date(t0.getTime() + 30_000));
    expect((await repo.listByUser(userId))[0].last_used_at).toBe(t0.toISOString());

    const t1 = new Date(t0.getTime() + 61_000);
    await repo.touchLastUsed(t.id, t1);
    expect((await repo.listByUser(userId))[0].last_used_at).toBe(t1.toISOString());
  });

  it('records events and purges the old ones', async () => {
    const t = await make(userId);
    await repo.recordEvent({ token_id: t.id, tool: 'list_machines', ok: true, duration_ms: 12 });
    await repo.recordEvent({ token_id: t.id, tool: 'read_screen', tab_id: 'tab1', ok: false, error_code: 'NOT_FOUND', duration_ms: 3 });
    await db.apiTokenEvent.updateMany({ where: { tokenId: t.id, tool: 'list_machines' }, data: { createdAt: new Date(Date.now() - 31 * DAY) } });

    expect(await repo.purgeEventsBefore(new Date(Date.now() - 30 * DAY))).toBe(1);
    const left = await db.apiTokenEvent.findMany({ where: { tokenId: t.id } });
    expect(left.map((e) => e.tool)).toEqual(['read_screen']);
  });

  it('deleting the user removes their tokens and events', async () => {
    const t = await make(userId);
    await repo.recordEvent({ token_id: t.id, tool: 'find', ok: true, duration_ms: 1 });
    await db.user.delete({ where: { id: userId } });
    expect(await db.apiToken.count({ where: { id: t.id } })).toBe(0);
    expect(await db.apiTokenEvent.count({ where: { tokenId: t.id } })).toBe(0);
  });
});
