import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { newId } from '../lib/ids.js';
import { publicId } from './public-id.js';

// The public read only ever consults the tmux memo; cold here, so `alive` falls back to the tab's state.
vi.mock('../terminal/machine-exec.js', () => ({ cachedTmuxProbe: () => undefined }));

const { readPublicCity } = await import('./read.js');

/**
 * The public city against the real schema (city-by-project §2.4): a city is the owner's published,
 * non-archived projects, one building each, and a building's robots are that project's tabs on the
 * machines the owner owns. No machine is ever part of it.
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

  async function published(name = 'Engage Easy', machines: string[] = [mine]) {
    const project = await repos.projects.create({ owner_id: pedro, key: key(), name });
    for (const machine_id of machines) await repos.projectMachines.link({ project_id: project.id, machine_id, cwd: '/w' });
    await repos.projects.update(project.id, { is_public: true });
    return project;
  }

  it('makes one building of a published project, with its robots from every machine the owner owns', async () => {
    const project = await published('Engage Easy', [mine, mine2]);
    await repos.tabs.create(project.id, mine, 'no jarvis');
    await repos.tabs.create(project.id, mine2, 'no friday');
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings).toHaveLength(1);
    expect(city.buildings[0]!.id).toBe(publicId('project', project.id));
    expect(city.buildings[0]!.name).toBe('Engage Easy');
    expect(city.buildings[0]!.robots.map((r) => r.name)).toEqual(['no jarvis', 'no friday']);
  });

  it('never shows a robot on a machine the owner does not own, nor any machine at all', async () => {
    const project = await published('Engage Easy', [mine, theirs]);
    await repos.tabs.create(project.id, mine, 'uma aba');
    await repos.tabs.create(project.id, theirs, 'na maquina alheia');
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings[0]!.robots.map((r) => r.name)).toEqual(['uma aba']);
    const body = JSON.stringify(city);
    for (const secret of ['Maquina Alheia', 'na maquina alheia', 'Jarvis', theirs, mine]) expect(body).not.toContain(secret);
  });

  // §2.4: a published project always appears, even with no agents ("sem agentes agora")
  it('keeps a published project whose agents all run elsewhere, or that has none, as an empty building', async () => {
    const elsewhere = await published('Alheio', [theirs]);
    await repos.tabs.create(elsewhere.id, theirs, 'na maquina alheia');
    await published('Sem maquina', []);
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings.map((b) => [b.name, b.robots.length])).toEqual([['Alheio', 0], ['Sem maquina', 0]]);
  });

  it('drops the robots of a machine that changed owner, keeping the building and its publish switch', async () => {
    const project = await published('Engage Easy', [mine, mine2]);
    await repos.tabs.create(project.id, mine, 'no jarvis');
    await repos.tabs.create(project.id, mine2, 'no friday');
    await repos.machines.update(mine2, { owner_id: other });
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings[0]!.robots.map((r) => r.name)).toEqual(['no jarvis']);
    expect((await repos.projects.findById(project.id))?.is_public).toBe(true);
    // and the new owner's city does not gain it: the project is not theirs
    await db.user.update({ where: { id: other }, data: { nickname: `${nick}o` } });
    expect(await readPublicCity(repos, `${nick}o`)).toBeUndefined();
  });

  it('leaves out private and archived projects, and orders the buildings by name', async () => {
    await published('Zeta');
    await published('Alfa');
    await repos.projects.create({ owner_id: pedro, key: key(), name: 'Privado' });
    const archived = await published('Arquivado');
    await repos.projects.update(archived.id, { status: 'archived' });
    const city = (await readPublicCity(repos, nick))!;
    expect(city.buildings.map((b) => b.name)).toEqual(['Alfa', 'Zeta']);
  });

  it('is no city at all when nothing is published', async () => {
    await repos.projects.create({ owner_id: pedro, key: key(), name: 'Privado' });
    expect(await readPublicCity(repos, nick)).toBeUndefined();
  });

  // The subtitle is the owner's own note about the machine ("MacBook do escritório"), and the
  // machine's name is no longer public either: neither ever reaches the street.
  it("never publishes a machine's name or subtitle", async () => {
    await repos.machines.update(mine, { subtitle: 'MacBook do escritório secreto' });
    const project = await published();
    await repos.tabs.create(project.id, mine, 'uma tab');
    const city = (await readPublicCity(repos, nick))!;
    expect(Object.keys(city.buildings[0]!).sort()).toEqual(['id', 'name', 'robots']);
    const body = JSON.stringify(city);
    for (const secret of ['subtitle', 'MacBook do escritório secreto', 'Jarvis', 'machine']) expect(body).not.toContain(secret);
  });
});
