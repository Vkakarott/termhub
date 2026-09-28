import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { GRANT_TTL_MS } from './chat-grants.js';
import { ChatProjectGrantsRepository } from './chat-project-grants.js';
import { ChatRepository } from './chat.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatProjectGrantsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatProjectGrantsRepository;
  let userId: string;
  let otherUserId: string;
  let conversationId: string;
  let otherConversationId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatProjectGrantsRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    const chat = new ChatRepository(db);
    conversationId = (await chat.getOrCreateForUser(userId)).id;
    otherConversationId = (await chat.getOrCreateForUser(otherUserId)).id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades conversations and grants
    await db.$disconnect();
  });

  const grant = (projectId: string, now?: Date) =>
    repo.grant({ conversation_id: conversationId, project_id: projectId, source_action_id: 'act1', granted_by: userId }, now);

  it('grants for 24 h and finds it for that conversation and project only', async () => {
    const g = await grant('p1');
    expect(Date.parse(g.expires_at) - Date.parse(g.created_at)).toBe(GRANT_TTL_MS);
    expect((await repo.findActive(conversationId, 'p1'))?.id).toBe(g.id);
    expect(await repo.findActive(conversationId, 'p2')).toBeUndefined();
    expect(await repo.findActive(otherConversationId, 'p1')).toBeUndefined();
  });

  it('re-granting revokes the previous one and restarts the clock', async () => {
    const first = await grant('p3');
    const second = await grant('p3');
    expect(second.id).not.toBe(first.id);
    expect((await repo.findActive(conversationId, 'p3'))?.id).toBe(second.id);
    expect((await repo.findByIdForUser(first.id, userId))?.revoked_by).toBe(userId);
  });

  it('ignores an expired grant', async () => {
    await grant('p4', new Date(Date.now() - GRANT_TTL_MS - 1000));
    expect(await repo.findActive(conversationId, 'p4')).toBeUndefined();
  });

  it('revoke is scoped by user and answers undefined the second time', async () => {
    const g = await grant('p5');
    expect(await repo.revoke(g.id, otherUserId)).toBeUndefined();
    expect((await repo.revoke(g.id, userId))?.revoked_at).not.toBeNull();
    expect(await repo.revoke(g.id, userId)).toBeUndefined();
  });

  it('revokeForConversation ends every active grant with revoked_by null', async () => {
    const g = await grant('p6');
    expect(await repo.revokeForConversation(conversationId)).toBeGreaterThan(0);
    expect((await repo.findByIdForUser(g.id, userId))?.revoked_by).toBeNull();
  });

  it('findActiveBySourceAction finds the grant a card created', async () => {
    const g = await grant('p7');
    expect((await repo.findActiveBySourceAction(conversationId, 'act1'))?.id).toBe(g.id);
  });

  it('stores the scope, board by default, and a re-grant replaces the other scope', async () => {
    // Its own user and conversation: `listActive` below asserts the whole conversation holds exactly
    // one active grant, which the shared `conversationId` above cannot promise (other tests in this
    // file leave their own active grants on it).
    const scopeUserId = newId();
    await db.user.create({ data: { id: scopeUserId, email: `${scopeUserId}@test.local`, name: 'scope' } });
    const scopeConversationId = (await new ChatRepository(db).getOrCreateForUser(scopeUserId)).id;
    try {
      const a = await repo.grant({ conversation_id: scopeConversationId, project_id: 'p1', granted_by: scopeUserId });
      expect(a.scope).toBe('board');
      const b = await repo.grant({ conversation_id: scopeConversationId, project_id: 'p1', granted_by: scopeUserId, scope: 'all' });
      expect(b.scope).toBe('all');
      expect((await repo.findActive(scopeConversationId, 'p1'))?.id).toBe(b.id);
      expect(await repo.listActive(scopeConversationId)).toHaveLength(1);
    } finally {
      await db.user.delete({ where: { id: scopeUserId } });
    }
  });

  it('listForUser splits active/ended, never shows another user, pages by (created_at, id)', async () => {
    // A fixed, old timestamp: rows other tests in this file left behind (revoked/expired "now") sort
    // before these on the (created_at desc) page order, so this walks every page instead of assuming
    // these three land on page 1 — the point is no duplicate/missing row and no other user's project.
    const t = new Date('2026-01-01T00:00:00.000Z');
    const mine: string[] = [];
    for (const p of ['q1', 'q2', 'q3']) mine.push((await repo.grant({ conversation_id: conversationId, project_id: p, granted_by: userId }, t)).id);
    await repo.grant({ conversation_id: otherConversationId, project_id: 'q9', granted_by: otherUserId });

    const seen: string[] = [];
    let cursor: { created_at: string; id: string } | null = null;
    for (let i = 0; i < 50; i++) {
      const page = await repo.listForUser(userId, { state: 'ended', cursor, limit: 2 });
      seen.push(...page.grants.map((g) => g.id));
      if (!page.next) break;
      cursor = page.next;
    }
    expect(new Set(seen).size).toBe(seen.length); // no row repeated across pages
    expect(mine.every((id) => seen.includes(id))).toBe(true); // none skipped
    expect(seen).not.toContain('q9'); // never another user's

    const active = await repo.listForUser(userId, { state: 'active', limit: 100 });
    expect(active.grants.every((g) => g.project_id !== 'q9')).toBe(true);
  });
});
