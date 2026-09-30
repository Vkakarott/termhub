import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';
import { TabLimitNoticesRepository } from './tab-limit-notices.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TabLimitNoticesRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TabLimitNoticesRepository;
  let userId: string;
  let projectId: string;
  let conv: string;
  const payload = { account: { id: 'a1', label: 'pessoal' }, machine: { id: 'm1', name: 'mac' }, resets_at: null, candidates: [{ id: 'a2', label: 'trabalho' }] };

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TabLimitNoticesRepository(db);
    userId = newId();
    projectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.project.create({ data: { id: projectId, key: `L${newId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'p', ownerId: userId } });
    conv = (await new ChatRepository(db).getOrCreateForUser(userId)).id;
  });

  afterAll(async () => {
    await db.project.delete({ where: { id: projectId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it('opens one card per incident, closes it once, and lists it for its conversation', async () => {
    const limitedAt = new Date('2026-09-30T02:30:00Z');
    const card = await repo.open({ tab_id: 't1', project_id: projectId, conversation_id: conv, limited_at: limitedAt, payload });
    expect(card).toMatchObject({ tab_id: 't1', status: 'open', user_id: userId, payload });
    expect(await repo.open({ tab_id: 't1', project_id: projectId, conversation_id: conv, limited_at: limitedAt, payload })).toBeUndefined();
    expect(await repo.findForUser(card!.id, 'someone-else')).toBeUndefined();
    expect((await repo.close(card!.id, 'swapped', 'a2'))?.status).toBe('swapped');
    expect(await repo.close(card!.id, 'dismissed')).toBeUndefined();
    const next = await repo.open({ tab_id: 't1', project_id: projectId, conversation_id: conv, limited_at: new Date('2026-09-30T08:00:00Z'), payload });
    expect((await repo.closeOpenForTab('t1', 'expired')).map((r) => r.id)).toEqual([next!.id]);
    expect((await repo.listByConversation(conv)).map((r) => r.status)).toEqual(['expired', 'swapped']);
  });
});
