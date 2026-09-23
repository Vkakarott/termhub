import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { newId } from '../lib/ids.js';
import { publicId, publicRoomId } from './public-id.js';

// The public read only ever consults the tmux memo; cold here, so `alive` falls back to the tab's state.
vi.mock('../terminal/machine-exec.js', () => ({ cachedTmuxProbe: () => undefined }));

const { readPublicCity } = await import('./read.js');

/**
 * The public city against the real schema after the merge with projects-decoupled (rulings 2–4):
 * a city is the owner's published projects on the machines the owner owns, one room per
 * (project, machine), robots placed by `tabs.machine_id`.
 */
// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('readPublicCity (Postgres)', () => {
  let db: PrismaClient;
  let repos: Repositories;
  let pedro: string;
  let other: string;
  let nick: string;
  let mine: string;
  let mine2: string;
  let theirs: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const key = () => `K${newId(8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

  beforeEach(async () => {
    pedro = newId();
    other = newId();
    nick = `pc${newId(10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await db.user.createMany({ data: [
      { id: pedro, email: `${pedro}@test.local`, name: 'Pedro', nickname: nick },
      { id: other, email: `${other}@test.local`, name: 'Outra' },
    ] });
    [mine, mine2, theirs] = [newId(), newId(), newId()];
    await db.machine.createMany({ data: [
      { id: mine, name: 'Jarvis', type: 'agent', ownerId: pedro },
      { id: mine2, name: 'Friday', type: 'agent', ownerId: pedro },
      { id: theirs, name: 'Maquina Alheia', type: 'agent', ownerId: other },
    ] });
    return async () => {
      await db.project.deleteMany({ where: { ownerId: { in: [pedro, other] } } });
      await db.machine.deleteMany({ where: { id: { in: [mine, mine2, theirs] } } });
      await db.user.deleteMany({ where: { id: { in: [pedro, other] } } });
    };
  });

  async function publishedOn(machines: string[], name = 'Engage Easy') {
    const project = await repos.projects.create({ owner_id: pedro, key: key(), name });
    for (const machine_id of machines) await repos.projectMachines.link({ project_id: project.id, machine_id, cwd: '/w' });
    await repos.projects.update(project.id, { is_public: true });
    return project;
  }

  it('splits a published project into one room per owned machine, robots placed by their machine', async () => {
    const project = await publishedOn([mine, mine2]);
    await repos.tabs.create(project.id, mine, 'no jarvis');
    await repos.tabs.create(project.id, mine2, 'no friday');
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings.map((b) => b.name).sort()).toEqual(['Friday', 'Jarvis']);
    const jarvis = city.buildings.find((b) => b.name === 'Jarvis');
    const friday = city.buildings.find((b) => b.name === 'Friday');
    expect(jarvis!.id).toBe(publicId('machine', mine));
    expect(jarvis!.rooms.map((r) => r.id)).toEqual([publicRoomId(project.id, mine)]);
    expect(friday!.rooms.map((r) => r.id)).toEqual([publicRoomId(project.id, mine2)]);
    expect(jarvis!.rooms[0]!.robots.map((r) => r.name)).toEqual(['no jarvis']);
    expect(friday!.rooms[0]!.robots.map((r) => r.name)).toEqual(['no friday']);
  });

  it('never exposes a machine the owner does not own, nor the robots on it', async () => {
    const project = await publishedOn([mine, theirs]);
    await repos.tabs.create(project.id, theirs, 'na maquina alheia');
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings.map((b) => b.name)).toEqual(['Jarvis']);
    const body = JSON.stringify(city);
    expect(body).not.toContain('Maquina Alheia');
    expect(body).not.toContain('na maquina alheia');
    expect(body).not.toContain(publicId('machine', theirs));
  });

  it('is no city at all when the only published project runs on somebody else\'s machine', async () => {
    await publishedOn([theirs]);
    expect(await readPublicCity(repos, nick)).toBeUndefined();
  });

  // Ruling 4: a transferred machine leaves the old owner's city by the rule alone; the project
  // stays published and keeps its rooms on the machines the owner still has.
  it('drops a building whose owner changed, without unpublishing the project', async () => {
    const project = await publishedOn([mine, mine2]);
    await repos.machines.update(mine2, { owner_id: other });
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings.map((b) => b.name)).toEqual(['Jarvis']);
    expect((await repos.projects.findById(project.id))?.is_public).toBe(true);
    // and the new owner's city does not gain it: the project is not theirs
    await db.user.update({ where: { id: other }, data: { nickname: `${nick}o` } });
    expect(await readPublicCity(repos, `${nick}o`)).toBeUndefined();
  });

  it('leaves out private and archived projects on the same machine', async () => {
    await publishedOn([mine], 'Publico');
    const priv = await repos.projects.create({ owner_id: pedro, key: key(), name: 'Privado' });
    await repos.projectMachines.link({ project_id: priv.id, machine_id: mine, cwd: '/w' });
    const archived = await publishedOn([mine], 'Arquivado');
    await repos.projects.update(archived.id, { status: 'archived' });
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings[0]!.rooms.map((r) => r.name)).toEqual(['Publico']);
  });
});
