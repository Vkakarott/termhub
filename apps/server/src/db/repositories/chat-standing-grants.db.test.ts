import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatStandingGrantsRepository } from './chat-standing-grants.js';
import { ChatRepository } from './chat.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatStandingGrantsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatStandingGrantsRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  let otherProjectId: string;
  let conversationId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatStandingGrantsRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    projectId = newId();
    otherProjectId = newId();
    await db.project.create({ data: { id: projectId, key: `SG${projectId.slice(0, 6).toUpperCase()}`, name: 'p1', ownerId: userId } });
    await db.project.create({ data: { id: otherProjectId, key: `SG${otherProjectId.slice(0, 6).toUpperCase()}`, name: 'p2', ownerId: userId } });
    conversationId = (await new ChatRepository(db).getOrCreateForUser(userId)).id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades conversations and grants
    await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await db.$disconnect();
  });

  const grant = (kind: Parameters<typeof repo.grant>[0]['kind'], overrides: Partial<Parameters<typeof repo.grant>[0]> = {}) =>
    repo.grant({ user_id: userId, project_id: projectId, kind, conversation_id: conversationId, source_action_id: 'act1', ...overrides });

  it('grants an active row and finds it', async () => {
    const g = await grant('open_tab');
    expect(g.revoked_at).toBeNull();
    expect((await repo.findActive(userId, projectId, 'open_tab'))?.id).toBe(g.id);
  });

  it('re-granting the same triple revokes the previous row and returns a new id', async () => {
    const first = await grant('close_tab');
    const second = await grant('close_tab');
    expect(second.id).not.toBe(first.id);
    expect((await repo.findActive(userId, projectId, 'close_tab'))?.id).toBe(second.id);
    expect((await repo.findByIdForUser(first.id, userId))?.revoked_by).toBe(userId);
    expect((await repo.findByIdForUser(first.id, userId))?.revoked_at).not.toBeNull();
  });

  it('findActive ignores a revoked row, another user, another project and another kind', async () => {
    const g = await grant('start_agent');
    // another kind
    expect(await repo.findActive(userId, projectId, 'board')).toBeUndefined();
    // another project
    expect(await repo.findActive(userId, otherProjectId, 'start_agent')).toBeUndefined();
    // another user
    expect(await repo.findActive(otherUserId, projectId, 'start_agent')).toBeUndefined();
    // revoked
    await repo.revoke(g.id, userId);
    expect(await repo.findActive(userId, projectId, 'start_agent')).toBeUndefined();
  });

  it('revoke is scoped by user and answers undefined for another user or an already revoked row', async () => {
    const g = await grant('terminal');
    expect(await repo.revoke(g.id, otherUserId)).toBeUndefined();
    const revoked = await repo.revoke(g.id, userId);
    expect(revoked?.revoked_at).not.toBeNull();
    expect(revoked?.revoked_by).toBe(userId);
    expect(await repo.revoke(g.id, userId)).toBeUndefined();
  });

  it('findActiveBySourceAction finds the grant a card created', async () => {
    const uid = newId();
    await db.user.create({ data: { id: uid, email: `${uid}@test.local`, name: 'src' } });
    const pid = newId();
    await db.project.create({ data: { id: pid, key: `SG${pid.slice(0, 6).toUpperCase()}`, name: 'p-src', ownerId: uid } });
    try {
      const g = await repo.grant({ user_id: uid, project_id: pid, kind: 'board', source_action_id: 'src-act' });
      expect((await repo.findActiveBySourceAction(uid, 'src-act'))?.id).toBe(g.id);
      expect(await repo.findActiveBySourceAction(uid, 'nope')).toBeUndefined();
    } finally {
      await db.user.delete({ where: { id: uid } });
      await db.project.delete({ where: { id: pid } });
    }
  });

  it('listActive lists only in-force rows of that user, optionally filtered by project', async () => {
    const uid = newId();
    await db.user.create({ data: { id: uid, email: `${uid}@test.local`, name: 'active' } });
    const pidA = newId();
    const pidB = newId();
    await db.project.create({ data: { id: pidA, key: `SG${pidA.slice(0, 6).toUpperCase()}`, name: 'pA', ownerId: uid } });
    await db.project.create({ data: { id: pidB, key: `SG${pidB.slice(0, 6).toUpperCase()}`, name: 'pB', ownerId: uid } });
    try {
      const a = await repo.grant({ user_id: uid, project_id: pidA, kind: 'open_tab' });
      const b = await repo.grant({ user_id: uid, project_id: pidB, kind: 'board' });
      const revoked = await repo.grant({ user_id: uid, project_id: pidA, kind: 'terminal' });
      await repo.revoke(revoked.id, uid);

      const all = await repo.listActive(uid);
      expect(all.map((g) => g.id).sort()).toEqual([a.id, b.id].sort());
      expect(await repo.listActive(uid, pidA)).toEqual([expect.objectContaining({ id: a.id })]);
      expect(await repo.listActive(otherUserId)).toEqual([]);
    } finally {
      await db.user.delete({ where: { id: uid } });
      await db.project.deleteMany({ where: { id: { in: [pidA, pidB] } } });
    }
  });

  it('listForUser splits active/ended, never another user, pages ended by (created_at, id) newest first', async () => {
    const uid = newId();
    await db.user.create({ data: { id: uid, email: `${uid}@test.local`, name: 'paging' } });
    const pid = newId();
    await db.project.create({ data: { id: pid, key: `SG${pid.slice(0, 6).toUpperCase()}`, name: 'p-page', ownerId: uid } });
    try {
      const t = new Date('2026-01-01T00:00:00.000Z');
      const kinds: Array<'open_tab' | 'close_tab' | 'start_agent'> = ['open_tab', 'close_tab', 'start_agent'];
      const endedIds: string[] = [];
      for (const kind of kinds) {
        const g = await repo.grant({ user_id: uid, project_id: pid, kind }, t);
        await repo.revoke(g.id, uid, t);
        endedIds.push(g.id);
      }
      const stillActive = await repo.grant({ user_id: uid, project_id: pid, kind: 'board' }, t);

      // one page at a time, limit smaller than the set, to exercise `next`
      const seen: string[] = [];
      let cursor: { created_at: string; id: string } | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await repo.listForUser(uid, { state: 'ended', cursor, limit: 2 });
        seen.push(...page.grants.map((g) => g.id));
        if (!page.next) break;
        cursor = page.next;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual(endedIds.sort());

      const active = await repo.listForUser(uid, { state: 'active', limit: 100 });
      expect(active.grants.map((g) => g.id)).toEqual([stillActive.id]);
      expect(active.grants.every((g) => g.conversation_project_id === null || typeof g.conversation_project_id === 'string')).toBe(true);
    } finally {
      await db.user.delete({ where: { id: uid } });
      await db.project.delete({ where: { id: pid } });
    }
  });

  it('deleting the project cascades the grant', async () => {
    const uid = newId();
    await db.user.create({ data: { id: uid, email: `${uid}@test.local`, name: 'cascade-project' } });
    const pid = newId();
    await db.project.create({ data: { id: pid, key: `SG${pid.slice(0, 6).toUpperCase()}`, name: 'p-cascade', ownerId: uid } });
    const g = await repo.grant({ user_id: uid, project_id: pid, kind: 'open_tab' });
    await db.project.delete({ where: { id: pid } });
    expect(await repo.findByIdForUser(g.id, uid)).toBeUndefined();
    await db.user.delete({ where: { id: uid } });
  });

  it('deleting the conversation nulls conversation_id but keeps the grant', async () => {
    const uid = newId();
    await db.user.create({ data: { id: uid, email: `${uid}@test.local`, name: 'cascade-conv' } });
    const pid = newId();
    await db.project.create({ data: { id: pid, key: `SG${pid.slice(0, 6).toUpperCase()}`, name: 'p-conv', ownerId: uid } });
    const convId = (await new ChatRepository(db).getOrCreateForUser(uid)).id;
    try {
      const g = await repo.grant({ user_id: uid, project_id: pid, kind: 'open_tab', conversation_id: convId });
      expect(g.conversation_id).toBe(convId);
      await db.chatConversation.delete({ where: { id: convId } });
      const after = await repo.findByIdForUser(g.id, uid);
      expect(after).toBeDefined();
      expect(after?.conversation_id).toBeNull();
    } finally {
      await db.user.delete({ where: { id: uid } });
      await db.project.delete({ where: { id: pid } });
    }
  });
});
