import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatActionsRepository } from './chat-actions.js';
import { ChatRepository } from './chat.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatActionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatActionsRepository;
  let conversationId: string;
  let userId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatActionsRepository(db);
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    conversationId = (await new ChatRepository(db).getOrCreateForUser(userId)).id;
  });

  afterAll(async () => {
    await db.user.delete({ where: { id: userId } }); // cascades the conversation and its actions
    await db.$disconnect();
  });

  const pending = (key: string) => repo.insertPending({ conversation_id: conversationId, tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, idempotency_key: key, class: 'write' });

  it('finds an open row by its key and does not see a decided one', async () => {
    const row = await pending('k1');
    expect(row.status).toBe('pending');
    expect((await repo.findOpenByKey(conversationId, 'k1'))?.id).toBe(row.id);

    await repo.decide(row.id, userId, 'denied');
    expect(await repo.findOpenByKey(conversationId, 'k1')).toBeUndefined();
  });

  it('refuses a second open row for the same key, so a retry cannot ask twice', async () => {
    await pending('k2');
    await expect(pending('k2')).rejects.toThrow(); // partial unique index on the open statuses
  });

  it('lets the same key through again once the first row is decided and executed', async () => {
    const first = await pending('k3');
    await repo.decide(first.id, userId, 'approved');
    await repo.markExecuted(first.id, true, null, 12);
    const again = await pending('k3');
    expect(again.id).not.toBe(first.id);
  });

  it('records who decided and when, and keeps the arguments as given', async () => {
    const row = await pending('k4');
    const decided = await repo.decide(row.id, userId, 'approved');
    expect(decided?.decided_by).toBe(userId);
    expect(decided?.decided_at).not.toBeNull();
    expect(decided?.args).toEqual({ tab_id: 't1', text: 'npm test' });
  });

  it('never lets another user decide', async () => {
    const row = await pending('k5');
    expect(await repo.decide(row.id, newId(), 'approved')).toBeUndefined();
    expect((await repo.findOpenByKey(conversationId, 'k5'))?.status).toBe('pending');
  });

  it('finds a denial by its key, with when it was decided, and ignores an executed row', async () => {
    const refused = await pending('k8');
    await repo.decide(refused.id, userId, 'denied');
    const found = await repo.findDeniedByKey(conversationId, 'k8');
    expect(found?.id).toBe(refused.id);
    expect(found?.decided_at).not.toBeNull(); // the gate dates its refusal window from this

    const done = await pending('k9');
    await repo.decide(done.id, userId, 'approved');
    await repo.markExecuted(done.id, true, null, 5);
    expect(await repo.findDeniedByKey(conversationId, 'k9')).toBeUndefined();
  });

  it('does not treat a question left to expire as a denial: nobody answered it', async () => {
    const forgotten = await pending('k10');
    await db.$executeRawUnsafe(`update chat_actions set created_at = now() - interval '2 days' where id = $1`, forgotten.id);
    await repo.expireOlderThan(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(await repo.findDeniedByKey(conversationId, 'k10')).toBeUndefined();
  });

  it('lets exactly one caller claim an approved action', async () => {
    const row = await pending('k12');
    await repo.decide(row.id, userId, 'approved');
    const claims = await Promise.all([repo.claimApproved(row.id), repo.claimApproved(row.id), repo.claimApproved(row.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1); // one approval must not be executed twice
    expect(await repo.findOpenByKey(conversationId, 'k12')).toBeUndefined(); // and is not claimable again
  });

  it('refuses to claim an action the user never approved', async () => {
    const row = await pending('k13');
    expect(await repo.claimApproved(row.id)).toBe(false);
    expect((await repo.findOpenByKey(conversationId, 'k13'))?.status).toBe('pending');
  });

  it('returns the newest denial when the same proposal was refused twice', async () => {
    const first = await pending('k11');
    await repo.decide(first.id, userId, 'denied');
    const second = await pending('k11'); // allowed again: the index only covers the open statuses
    await repo.decide(second.id, userId, 'denied');
    expect((await repo.findDeniedByKey(conversationId, 'k11'))?.id).toBe(second.id);
  });

  it('expires rows older than the cutoff and leaves fresh ones alone', async () => {
    const old = await pending('k6');
    await db.$executeRawUnsafe(`update chat_actions set created_at = now() - interval '2 days' where id = $1`, old.id);
    const fresh = await pending('k7');
    expect(await repo.expireOlderThan(new Date(Date.now() - 24 * 60 * 60 * 1000))).toBe(1);
    expect((await repo.findOpenByKey(conversationId, 'k7'))?.id).toBe(fresh.id);
  });
});
