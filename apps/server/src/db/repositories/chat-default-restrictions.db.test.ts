import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatDefaultRestrictionsRepository } from './chat-default-restrictions.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatDefaultRestrictionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatDefaultRestrictionsRepository;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatDefaultRestrictionsRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades the rows
    await db.$disconnect();
  });

  it('a user with no row has every default on', async () => {
    expect(await repo.listForUser(userId)).toEqual(new Set());
    expect((await repo.stateForUser(userId)).every((d) => d.allowed)).toBe(true);
  });

  it('restricts and re-allows one kind, idempotently, for that user only', async () => {
    await repo.setAllowed(userId, 'terminal', false);
    await repo.setAllowed(userId, 'terminal', false);
    expect(await repo.listForUser(userId)).toEqual(new Set(['terminal']));
    expect(await repo.listForUser(otherUserId)).toEqual(new Set());
    expect((await repo.stateForUser(userId)).find((d) => d.kind === 'terminal')?.allowed).toBe(false);
    await repo.setAllowed(userId, 'terminal', true);
    await repo.setAllowed(userId, 'terminal', true);
    expect(await repo.listForUser(userId)).toEqual(new Set());
  });

  it('ignores a kind the code no longer knows', async () => {
    await db.chatDefaultRestriction.create({ data: { userId, kind: 'retired_kind' } });
    expect(await repo.listForUser(userId)).toEqual(new Set());
  });
});
