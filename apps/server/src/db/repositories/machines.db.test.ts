import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { MachinesRepository } from './machines.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see tasks.db.test.ts for the local Docker recipe).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('MachinesRepository.findByIdsForOwner (Postgres)', () => {
  let db: PrismaClient;
  let repo: MachinesRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new MachinesRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('finds machines by id in one query, filtered to one owner — another owner\'s machine does not resolve, neither does an orphan\'s', async () => {
    const ownerId = newId();
    const otherOwnerId = newId();
    const ownedMachineId = newId();
    const otherMachineId = newId();
    const orphanMachineId = newId();
    await db.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' },
      { id: otherOwnerId, email: `${otherOwnerId}@test.local`, name: 'other' },
    ] });
    try {
      await db.machine.createMany({ data: [
        { id: ownedMachineId, name: 'mine', type: 'agent', ownerId },
        { id: otherMachineId, name: 'theirs', type: 'agent', ownerId: otherOwnerId },
        { id: orphanMachineId, name: 'orphan', type: 'agent' }, // ownerId null — never resolves for a concrete owner either
      ] });

      const found = await repo.findByIdsForOwner([ownedMachineId, otherMachineId, orphanMachineId, 'nope'], ownerId);
      expect(found.map((m) => m.id)).toEqual([ownedMachineId]);
      expect(await repo.findByIdsForOwner([], ownerId)).toEqual([]);
    } finally {
      await db.machine.deleteMany({ where: { id: { in: [ownedMachineId, otherMachineId, orphanMachineId] } } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } });
    }
  });
});
