import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectRuleError, ProjectsRepository } from './projects.js';
import { ProjectMachinesRepository } from './project-machines.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ProjectsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ProjectsRepository;
  let links: ProjectMachinesRepository;
  let ownerId: string;
  let otherId: string;
  let machineId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ProjectsRepository(db);
    links = new ProjectMachinesRepository(db);
  });

  beforeEach(async () => {
    ownerId = newId();
    otherId = newId();
    machineId = newId();
    await db.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' },
      { id: otherId, email: `${otherId}@test.local`, name: 'other' },
    ] });
    await db.machine.create({ data: { id: machineId, name: 'mine', type: 'agent', ownerId } });
    return async () => {
      await db.project.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const key = () => 'T' + newId().replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

  it('creates a project owned by a user with a valid unique key', async () => {
    const k = key();
    const p = await repo.create({ owner_id: ownerId, key: k, name: 'mine' });
    expect(p).toMatchObject({ owner_id: ownerId, key: k, next_task_number: 1, status: 'active' });
    expect(await repo.findByKey(k)).toMatchObject({ id: p.id });
    expect(await repo.isKeyAvailable(k)).toBe(false);
    expect(await repo.isKeyAvailable(key())).toBe(true);
  });

  it('rejects an invalid or taken key with a rule error', async () => {
    const k = key();
    await repo.create({ owner_id: ownerId, key: k, name: 'a' });
    await expect(repo.create({ owner_id: ownerId, key: k, name: 'b' })).rejects.toMatchObject({ code: 'KEY_TAKEN' } satisfies Partial<ProjectRuleError>);
    await expect(repo.create({ owner_id: ownerId, key: 'bad key', name: 'c' })).rejects.toMatchObject({ code: 'KEY_INVALID' });
    expect(await repo.isKeyAvailable('bad key')).toBe(false);
  });

  it('lists by owner directly and by linked machine', async () => {
    const mine = await repo.create({ owner_id: ownerId, key: key(), name: 'mine' });
    const theirs = await repo.create({ owner_id: otherId, key: key(), name: 'theirs' });
    await links.link({ project_id: mine.id, machine_id: machineId, cwd: '/src/mine' });

    expect((await repo.list({ owner: ownerId })).map((p) => p.id)).toEqual([mine.id]);
    expect((await repo.list({ owner: otherId })).map((p) => p.id)).toEqual([theirs.id]);
    expect((await repo.list({ machine_id: machineId })).map((p) => p.id)).toEqual([mine.id]);
    expect((await repo.findByIdsForOwner([mine.id, theirs.id, 'nope'], ownerId)).map((p) => p.id)).toEqual([mine.id]);
  });

  it('update changes name/status/description only; the key never changes', async () => {
    const p = await repo.create({ owner_id: ownerId, key: key(), name: 'a' });
    const u = await repo.update(p.id, { name: 'b', status: 'paused', description: 'd' });
    expect(u).toMatchObject({ key: p.key, name: 'b', status: 'paused', description: 'd' });
  });
});
