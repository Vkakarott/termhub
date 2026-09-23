import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectsRepository } from './projects.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see tasks.db.test.ts for the local Docker recipe).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ProjectsRepository.findByIdsForOwner (Postgres)', () => {
  let db: PrismaClient;
  let repo: ProjectsRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ProjectsRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('finds projects by id in one query, filtered to one owner through their machine — another owner\'s project does not resolve', async () => {
    const ownerId = newId();
    const otherOwnerId = newId();
    const ownedMachineId = newId();
    const otherMachineId = newId();
    const ownedProjectId = newId();
    const otherProjectId = newId();
    await db.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' },
      { id: otherOwnerId, email: `${otherOwnerId}@test.local`, name: 'other' },
    ] });
    try {
      await db.machine.createMany({ data: [
        { id: ownedMachineId, name: 'mine', type: 'agent', ownerId },
        { id: otherMachineId, name: 'theirs', type: 'agent', ownerId: otherOwnerId },
      ] });
      await db.project.createMany({ data: [
        { id: ownedProjectId, machineId: ownedMachineId, name: 'mine', cwd: '/tmp' },
        { id: otherProjectId, machineId: otherMachineId, name: 'theirs', cwd: '/tmp' },
      ] });

      const found = await repo.findByIdsForOwner([ownedProjectId, otherProjectId, 'nope'], ownerId);
      expect(found.map((p) => p.id)).toEqual([ownedProjectId]); // another owner's project is absent, indistinguishable from "does not exist"
      expect(await repo.findByIdsForOwner([], ownerId)).toEqual([]);
    } finally {
      await db.machine.deleteMany({ where: { id: { in: [ownedMachineId, otherMachineId] } } }); // cascades both projects
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } });
    }
  });

  it('unpublishByMachine takes every published project of one machine off the street, and names them', async () => {
    const ownerId = newId();
    const machineId = newId();
    const otherMachineId = newId();
    const [pub, priv, otherPub] = [newId(), newId(), newId()];
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    try {
      await db.machine.createMany({ data: [
        { id: machineId, name: 'm', type: 'agent', ownerId },
        { id: otherMachineId, name: 'o', type: 'agent', ownerId },
      ] });
      await db.project.createMany({ data: [
        { id: pub, machineId, name: 'pub', cwd: '/tmp', isPublic: true },
        { id: priv, machineId, name: 'priv', cwd: '/tmp' },
        { id: otherPub, machineId: otherMachineId, name: 'other', cwd: '/tmp', isPublic: true },
      ] });
      expect(await repo.unpublishByMachine(machineId)).toEqual([pub]);
      expect((await repo.findById(pub))?.is_public).toBe(false);
      expect((await repo.findById(otherPub))?.is_public).toBe(true);
      expect(await repo.unpublishByMachine(machineId)).toEqual([]);
    } finally {
      await db.machine.deleteMany({ where: { id: { in: [machineId, otherMachineId] } } });
      await db.user.deleteMany({ where: { id: ownerId } });
    }
  });
});
