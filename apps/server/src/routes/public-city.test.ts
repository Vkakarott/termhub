import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';

// The public read must never trigger an ssh round-trip: it only ever consults the memo
// (`cachedTmuxProbe`, synchronous) and must never call the probing function that would refresh it.
const probingFn = vi.fn(async () => {
  throw new Error('probeTmuxSessionsCached must never be called from the public read');
});
let cached: { reachable: boolean; sessions: Set<string> } | undefined = { reachable: true, sessions: new Set(['th-t1']) };
const cachedFn = vi.fn(() => cached);
vi.mock('../terminal/machine-exec.js', () => ({
  probeTmuxSessionsCached: (...a: unknown[]) => probingFn(...a),
  cachedTmuxProbe: (...a: unknown[]) => cachedFn(...a),
}));

const { publicCityRoutes } = await import('./public-city.js');

const MACHINES = [
  { id: 'm1', name: 'Jarvis Office', owner_id: 'u1' },
  { id: 'm2', name: 'Empty HQ', owner_id: 'u2' },
  { id: 'm3', name: 'Rival HQ', owner_id: 'u3' },
];

const PROJECTS: Record<string, { id: string; machine_id: string; name: string; status: string; is_public: boolean }[]> = {
  m1: [
    { id: 'p1', machine_id: 'm1', name: 'Engage Easy', status: 'active', is_public: true },
    { id: 'p2', machine_id: 'm1', name: 'Projeto Secreto', status: 'active', is_public: false },
    { id: 'p3', machine_id: 'm1', name: 'Projeto Arquivado', status: 'archived', is_public: true },
  ],
  m2: [],
  m3: [{ id: 'p4', machine_id: 'm3', name: 'Rival Room', status: 'active', is_public: true }],
};

const TABS: Record<string, { id: string; project_id: string; name: string; kind: string; tmux_session: string | null; simulator_udid: string | null; state: string | null }[]> = {
  p1: [{ id: 't1', project_id: 'p1', name: 'shell', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, state: 'working' }],
  p2: [{ id: 't2', project_id: 'p2', name: 'segredo', kind: 'terminal', tmux_session: 'th-t2', simulator_udid: null, state: 'working' }],
  p4: [{ id: 't4', project_id: 'p4', name: 'rival shell', kind: 'terminal', tmux_session: 'th-t4', simulator_udid: null, state: 'working' }],
};

/** The public route with stubbed repositories, built the way office.test.ts builds its app. */
function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  const repos = {
    users: {
      findByNickname: vi.fn(async (nickname: string) =>
        nickname === 'pedro'
          ? { id: 'u1', name: 'Pedro' }
          : nickname === 'semnada'
            ? { id: 'u2', name: 'Semnada' }
            : undefined,
      ),
    },
    machines: {
      // A real repository already scopes by owner (see machines.ts: `list(owner: OwnerScope)`).
      // Returning every machine here and letting the mock filter by the argument the same way the
      // real query does is what makes the "another owner's machine" test meaningful: it fails the
      // moment `readPublicCity` stops passing `owner.id` through.
      list: vi.fn(async (ownerId?: string | null) => MACHINES.filter((m) => m.owner_id === ownerId)),
    },
    projects: {
      list: vi.fn(async ({ machine_id }: { machine_id: string }) => PROJECTS[machine_id] ?? []),
    },
    tabs: {
      listByProjects: vi.fn(async (projectIds: string[]) => projectIds.flatMap((id) => TABS[id] ?? [])),
    },
  } as unknown as Repositories;
  app.register((instance) => publicCityRoutes(instance, repos), { prefix: '/public' });
  return { app, repos };
}

describe('GET /public/city/:nickname', () => {
  beforeEach(() => {
    cached = { reachable: true, sessions: new Set(['th-t1']) };
    probingFn.mockClear();
    cachedFn.mockClear();
  });

  it('answers the city of a nickname that has a public project', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(res.statusCode).toBe(200);
    expect(res.json().nickname).toBe('pedro');
    expect(res.json().buildings[0].rooms.map((r: { name: string }) => r.name)).toEqual(['Engage Easy']);
  });

  it('leaves out the private rooms of the same machine', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Projeto Secreto');
  });

  it('leaves out an archived project even though it is public', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Projeto Arquivado');
  });

  it('never asks for a private project\'s tabs — asserted on the repository call, not only on the body', async () => {
    const { app, repos } = buildApp();
    await app.inject({ method: 'GET', url: '/public/city/pedro' });
    // p2 (private) and p3 (archived) must never appear in the argument, not just in the response.
    // A regression that passed every project id through would still pass the body-only assertions
    // above, since PROJECTS.p2's tab carries no string that collides with 'Projeto Secreto'.
    expect(repos.tabs.listByProjects).toHaveBeenCalledWith(['p1']);
  });

  it('leaves out a machine that belongs to somebody else, even with a public project on it', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Rival Room');
    expect(body).not.toContain('Rival HQ');
  });

  it('404s an unknown nickname', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/public/city/ninguem' })).statusCode).toBe(404);
  });

  it('404s a nickname that exists but published nothing — an empty city would confirm the name', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/public/city/semnada' })).statusCode).toBe(404);
  });

  it('404s a nickname longer than normalizeNickname allows, the same as any other bad nickname', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: `/public/city/${'a'.repeat(65)}` })).statusCode).toBe(404);
  });

  it('never calls the network-triggering probe — only ever reads the memo', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(probingFn).not.toHaveBeenCalled();
    expect(cachedFn).toHaveBeenCalled();
  });

  it('performs no probe at all with a cold memo, and still answers with its robots', async () => {
    cached = undefined;
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(res.statusCode).toBe(200);
    expect(probingFn).not.toHaveBeenCalled();
    const robots = res.json().buildings[0].rooms[0].robots;
    expect(robots).toHaveLength(1);
    // cold memo: alive falls back to the tool's own reported state, not an empty-office read
    expect(robots[0].alive).toBe(true);
  });
});
