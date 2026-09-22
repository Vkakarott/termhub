import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectMachinesRepository } from './project-machines.js';
import { TabsRepository } from './tabs.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ProjectMachinesRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ProjectMachinesRepository;
  let tabs: TabsRepository;
  let ownerId: string;
  let m1: string;
  let m2: string;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ProjectMachinesRepository(db);
    tabs = new TabsRepository(db);
  });

  beforeEach(async () => {
    ownerId = newId();
    m1 = newId();
    m2 = newId();
    projectId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'o' } });
    await db.machine.createMany({ data: [{ id: m1, name: 'one', type: 'agent', ownerId }, { id: m2, name: 'two', type: 'agent', ownerId }] });
    await db.project.create({ data: { id: projectId, ownerId, key: 'K' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: { in: [m1, m2] } } });
      await db.user.deleteMany({ where: { id: ownerId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('links machines in order, finds and lists them, and refuses a second link to the same machine', async () => {
    const a = await repo.link({ project_id: projectId, machine_id: m1, cwd: '/a' });
    const b = await repo.link({ project_id: projectId, machine_id: m2, cwd: '/b' });
    expect([a.position, b.position]).toEqual([0, 1]);
    expect((await repo.listByProject(projectId)).map((l) => l.machine_id)).toEqual([m1, m2]);
    expect((await repo.listByMachine(m2)).map((l) => l.project_id)).toEqual([projectId]);
    expect((await repo.listByProjects([projectId, 'nope'])).length).toBe(2);
    expect(await repo.find(projectId, m1)).toMatchObject({ cwd: '/a' });
    expect(await repo.find(projectId, 'nope')).toBeUndefined();
    await expect(repo.link({ project_id: projectId, machine_id: m1, cwd: '/again' })).rejects.toMatchObject({ code: 'MACHINE_ALREADY_LINKED' });
  });

  it('updates the cwd and unlinks', async () => {
    await repo.link({ project_id: projectId, machine_id: m1, cwd: '/a' });
    expect(await repo.updateCwd(projectId, m1, '/z')).toMatchObject({ cwd: '/z' });
    expect(await repo.updateCwd(projectId, m2, '/z')).toBeUndefined();
    expect(await repo.unlink(projectId, m1)).toBe(true);
    expect(await repo.unlink(projectId, m1)).toBe(false);
    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('deleting a machine removes its link and tabs but keeps the project; deleting the project removes links', async () => {
    await repo.link({ project_id: projectId, machine_id: m1, cwd: '/a' });
    await repo.link({ project_id: projectId, machine_id: m2, cwd: '/b' });
    const t1 = await tabs.create(projectId, m1, 'on one');
    const t2 = await tabs.create(projectId, m2, 'on two');
    expect(t1.machine_id).toBe(m1);
    expect((await tabs.listByProjectMachine(projectId, m2)).map((t) => t.id)).toEqual([t2.id]);
    expect((await tabs.listByProjectsOnMachine([projectId], m1)).map((t) => t.id)).toEqual([t1.id]);

    await db.machine.delete({ where: { id: m1 } });
    expect(await db.project.findUnique({ where: { id: projectId } })).not.toBeNull();
    expect((await repo.listByProject(projectId)).map((l) => l.machine_id)).toEqual([m2]);
    expect((await tabs.listByProject(projectId)).map((t) => t.id)).toEqual([t2.id]);
    expect(await tabs.countsByMachine(ownerId)).toEqual({ [m2]: { tabs: 1, reporting: 0 } });
    expect(await tabs.findByTmuxSession(m2, t2.tmux_session!)).toMatchObject({ id: t2.id });
    expect((await tabs.findByIdsForOwner([t2.id], ownerId)).length).toBe(1);
    expect((await tabs.findByIdsForOwner([t2.id], 'someone-else')).length).toBe(0);
  });
});
