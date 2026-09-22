import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';

const probeCalls: { fresh?: boolean }[] = [];
const probe = vi.fn(async (_machine: unknown, opts: { fresh?: boolean } = {}) => {
  probeCalls.push(opts);
  return { reachable: true, sessions: new Set(['th-t1']) };
});
vi.mock('../terminal/machine-exec.js', () => ({ probeTmuxSessionsCached: (...a: unknown[]) => probe(...a) }));

const { publicCityRoutes } = await import('./public-city.js');

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
      list: vi.fn(async (ownerId?: string | null) =>
        ownerId === 'u1'
          ? [{ id: 'm1', name: 'Jarvis Office', owner_id: 'u1' }]
          : ownerId === 'u2'
            ? [{ id: 'm2', name: 'Empty HQ', owner_id: 'u2' }]
            : [],
      ),
    },
    projects: {
      list: vi.fn(async ({ machine_id }: { machine_id: string }) =>
        machine_id === 'm1'
          ? [
              { id: 'p1', machine_id: 'm1', name: 'Engage Easy', status: 'active', is_public: true },
              { id: 'p2', machine_id: 'm1', name: 'Projeto Secreto', status: 'active', is_public: false },
            ]
          : [],
      ),
    },
    tabs: {
      listByProjects: vi.fn(async (projectIds: string[]) =>
        projectIds.includes('p1')
          ? [{ id: 't1', project_id: 'p1', name: 'shell', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null }]
          : [],
      ),
    },
  } as unknown as Repositories;
  app.register((instance) => publicCityRoutes(instance, repos), { prefix: '/public' });
  return { app, repos };
}

describe('GET /public/city/:nickname', () => {
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

  it('404s an unknown nickname', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/public/city/ninguem' })).statusCode).toBe(404);
  });

  it('404s a nickname that exists but published nothing — an empty city would confirm the name', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/public/city/semnada' })).statusCode).toBe(404);
  });

  it('does not ask the machine for a fresh tmux probe', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(probeCalls.every((c) => c.fresh === false)).toBe(true);
  });
});
