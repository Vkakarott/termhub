import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';

vi.mock('../terminal/machine-exec.js', () => ({ cachedTmuxProbe: () => undefined }));

const { PUBLIC_CITY_MEMO_MAX, PUBLIC_CITY_MEMO_MS, clearPublicCityMemo, readPublicCity, readPublicCityCached, resolvePublicCity } = await import('./read.js');
const { publicBus } = await import('./bus.js');

function stubRepos() {
  const findByNickname = vi.fn(async (nickname: string) => ({ id: `u-${nickname}`, name: nickname }));
  const repos = {
    users: { findByNickname },
    machines: { list: vi.fn(async (owner: string) => [{ id: 'm1', name: 'M', owner_id: owner }]) },
    projects: { list: vi.fn(async (q: { owner: string }) => [{ id: 'p1', name: 'P', owner_id: q.owner, is_public: true, status: 'active' }]) },
    tabs: { listByProjects: vi.fn(async () => []) },
  } as unknown as Repositories;
  return { repos, findByNickname };
}

describe('readPublicCityCached', () => {
  beforeEach(() => clearPublicCityMemo());

  // Every anonymous surface (snapshot, city page, card) reads through this: one link click or one
  // crawler unfurl must not cost a full read per request.
  it('answers repeated reads of a nickname from one database read while it is fresh', async () => {
    const { repos, findByNickname } = stubRepos();
    let t = 1_000;
    const now = () => t;
    const a = await readPublicCityCached(repos, 'pedro', { now });
    t += PUBLIC_CITY_MEMO_MS - 1;
    const b = await readPublicCityCached(repos, 'pedro', { now });
    expect(b).toBe(a);
    expect(findByNickname).toHaveBeenCalledTimes(1);
    t += 2;
    await readPublicCityCached(repos, 'pedro', { now });
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    const { repos, findByNickname } = stubRepos();
    await Promise.all([readPublicCityCached(repos, 'pedro'), readPublicCityCached(repos, 'pedro'), readPublicCityCached(repos, 'pedro')]);
    expect(findByNickname).toHaveBeenCalledTimes(1);
  });

  // Unpublishing must stay immediate for every new read, memo or not.
  it('forgets everything the moment a project is published or unpublished', async () => {
    const { repos, findByNickname } = stubRepos();
    await readPublicCityCached(repos, 'pedro');
    publicBus.publish({ project_id: 'p1', is_public: false });
    await readPublicCityCached(repos, 'pedro');
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });

  // Robots leaving the street (owner reassigned, machine deleted, project unlinked) is as immediate
  // as an unpublish.
  it('forgets everything the moment robots leave the street', async () => {
    const { repos, findByNickname } = stubRepos();
    await readPublicCityCached(repos, 'pedro');
    publicBus.publishRobotsGone({ machine_id: 'm1' });
    await readPublicCityCached(repos, 'pedro');
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });

  it('forgets everything the moment an owner is deleted', async () => {
    const { repos, findByNickname } = stubRepos();
    await readPublicCityCached(repos, 'pedro');
    publicBus.publishOwnerGone({ owner_id: 'u-pedro' });
    await readPublicCityCached(repos, 'pedro');
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failed read', async () => {
    const { repos, findByNickname } = stubRepos();
    findByNickname.mockRejectedValueOnce(new Error('db down'));
    await expect(readPublicCityCached(repos, 'pedro')).rejects.toThrow('db down');
    expect(await readPublicCityCached(repos, 'pedro')).toBeDefined();
    expect(findByNickname).toHaveBeenCalledTimes(2);
  });

  it('stays bounded however many different nicknames are asked for', async () => {
    const { repos, findByNickname } = stubRepos();
    for (let i = 0; i <= PUBLIC_CITY_MEMO_MAX; i++) await readPublicCityCached(repos, `n${i}`);
    // the oldest entry was evicted to make room for the last one
    await readPublicCityCached(repos, 'n0');
    expect(findByNickname).toHaveBeenCalledTimes(PUBLIC_CITY_MEMO_MAX + 2);
    await readPublicCityCached(repos, `n${PUBLIC_CITY_MEMO_MAX}`);
    expect(findByNickname).toHaveBeenCalledTimes(PUBLIC_CITY_MEMO_MAX + 2);
  });
});

describe('resolvePublicCity', () => {
  function repos(projects: unknown[], machines: unknown[] = [{ id: 'm1', owner_id: 'u1' }]) {
    return { projects: { list: vi.fn(async () => projects) }, machines: { list: vi.fn(async () => machines) } } as unknown as Repositories;
  }

  // Defence in depth: `projects.list({ owner })` already filters, but a published project of
  // somebody else must never become a building even if that filter ever slips.
  it('drops a published project the owner does not own, even if the repository returns it', async () => {
    const r = repos([
      { id: 'p1', owner_id: 'u1', is_public: true, status: 'active' },
      { id: 'pX', owner_id: 'u2', is_public: true, status: 'active' },
      { id: 'pO', owner_id: null, is_public: true, status: 'active' },
    ]);
    expect((await resolvePublicCity(r, 'u1')).projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('keeps only published, non-archived projects, in the order given', async () => {
    const r = repos([
      { id: 'b', owner_id: 'u1', is_public: true, status: 'active' },
      { id: 'priv', owner_id: 'u1', is_public: false, status: 'active' },
      { id: 'arch', owner_id: 'u1', is_public: true, status: 'archived' },
      { id: 'a', owner_id: 'u1', is_public: true, status: 'paused' },
    ]);
    expect((await resolvePublicCity(r, 'u1')).projects.map((p) => p.id)).toEqual(['b', 'a']);
  });

  // the one line between a published project and somebody else's machine
  it('keeps only the machines the owner owns, even if the repository returns another', async () => {
    const r = repos([{ id: 'p1', owner_id: 'u1', is_public: true, status: 'active' }], [{ id: 'm1', owner_id: 'u1' }, { id: 'mX', owner_id: 'u2' }]);
    expect((await resolvePublicCity(r, 'u1')).machines.map((m) => m.id)).toEqual(['m1']);
  });

  it('reads no machine when nothing is published', async () => {
    const r = repos([{ id: 'p1', owner_id: 'u1', is_public: false, status: 'active' }]);
    expect(await resolvePublicCity(r, 'u1')).toEqual({ projects: [], machines: [] });
    expect(r.machines.list).not.toHaveBeenCalled();
  });

  // An empty id could read as "no owner filter" further down; it is refused before any read.
  it('refuses an empty owner id without reading anything', async () => {
    const r = repos([{ id: 'p1', owner_id: '', is_public: true, status: 'active' }]);
    expect(await resolvePublicCity(r, '')).toEqual({ projects: [], machines: [] });
    expect(r.projects.list).not.toHaveBeenCalled();
  });
});

describe('readPublicCity', () => {
  const tabRow = (id: string, projectId: string, machineId: string, name: string) => ({
    id, project_id: projectId, machine_id: machineId, name, kind: 'terminal', tmux_session: `th-${id}`, simulator_udid: null, position: 0,
    state: 'working', state_text: null, state_tool: 'claude', state_at: '2026-09-24T10:00:00.000Z', state_seen_at: null, activity: null, activity_verb: null, created_at: '',
  });

  it("reads every building's tabs in one query and keeps only those on a machine the owner owns", async () => {
    const listByProjects = vi.fn(async () => [tabRow('t1', 'p1', 'm1', 'minha'), tabRow('t2', 'p1', 'mX', 'alheia')]);
    const repos = {
      users: { findByNickname: async () => ({ id: 'u1', name: 'Pedro', city_short_url_partner: null, city_short_url_custom: null }) },
      projects: { list: async () => [{ id: 'p1', name: 'Engage', owner_id: 'u1', is_public: true, status: 'active' }, { id: 'p2', name: 'Vazio', owner_id: 'u1', is_public: true, status: 'active' }] },
      machines: { list: async () => [{ id: 'm1', owner_id: 'u1' }] },
      tabs: { listByProjects },
    } as unknown as Repositories;
    const city = (await readPublicCity(repos, 'pedro'))!;
    expect(listByProjects).toHaveBeenCalledTimes(1);
    expect(listByProjects).toHaveBeenCalledWith(['p1', 'p2']);
    // a published project with no robot of its own is still a building
    expect(city.buildings.map((b) => [b.name, b.robots.map((r) => r.name)])).toEqual([['Engage', ['minha']], ['Vazio', []]]);
  });
});
