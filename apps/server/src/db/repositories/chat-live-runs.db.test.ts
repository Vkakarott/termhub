import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';
import { ChatLiveRunsRepository } from './chat-live-runs.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatLiveRunsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatLiveRunsRepository;
  let userId: string;
  let conv: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatLiveRunsRepository(db);
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    conv = (await new ChatRepository(db).getOrCreateForUser(userId)).id;
  });

  afterAll(async () => {
    await db.user.delete({ where: { id: userId } }); // cascades the conversation and its live run
    await db.$disconnect();
  });

  it('saves, heartbeats and deletes only its own row', async () => {
    await repo.save({ conversation_id: conv, user_id: userId, instance_id: 'A', turns: [{ question_id: 'q', answer_id: 'a', text: 'oi' }] });
    expect(await repo.heartbeat('A')).toBe(1);
    await repo.delete(conv, 'B');
    expect(await repo.listResumable('B', new Date(Date.now() - 90_000))).toHaveLength(0); // fresh, not released
    await repo.delete(conv, 'A');
    expect(await repo.listResumable('B', new Date(Date.now() + 1000))).toHaveLength(0);
  });

  it('lists released or stale rows of other instances, and claims exactly once', async () => {
    await repo.save({ conversation_id: conv, user_id: userId, instance_id: 'A', turns: [] });
    expect(await repo.listResumable('A', new Date(Date.now() + 1000))).toHaveLength(0); // never its own
    await repo.release('A', new Map([[conv, [{ question_id: 'q2', answer_id: 'a2', text: 'x' }]]]));
    const [row] = await repo.listResumable('B', new Date(Date.now() - 90_000));
    expect(row.turns).toEqual([{ question_id: 'q2', answer_id: 'a2', text: 'x' }]);
    const staleBefore = new Date(Date.now() - 90_000);
    const results = await Promise.all([repo.claim(conv, 'A', 'B', staleBefore), repo.claim(conv, 'A', 'C', staleBefore)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await db.chatLiveRun.deleteMany({ where: { conversationId: conv } });
  });

  it('treats a stale heartbeat as resumable', async () => {
    await repo.save({ conversation_id: conv, user_id: userId, instance_id: 'A', turns: [] });
    await db.chatLiveRun.update({ where: { conversationId: conv }, data: { heartbeatAt: new Date(Date.now() - 120_000) } });
    expect(await repo.listResumable('B', new Date(Date.now() - 90_000))).toHaveLength(1);
  });
});
