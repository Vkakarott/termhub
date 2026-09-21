import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';

const listTmuxSessions = vi.fn();
const canAccess = vi.fn();
vi.mock('../terminal/machine-exec.js', () => ({ listTmuxSessions: (...a: unknown[]) => listTmuxSessions(...a) }));
vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: (...a: unknown[]) => canAccess(...a) }));

const { officeRoutes } = await import('./office.js');

function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const officeProgress = vi.fn(async () => ({ counts: { p1: { todo: 0, doing: 1, done: 0 } }, byTab: {} }));
  const repos = {
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? { id: 'm1', name: 'jarvis', owner_id: 'u1' } : id === 'm2' ? { id: 'm2', name: 'other', owner_id: 'someone-else' } : undefined)) },
    projects: { list: vi.fn(async () => [{ id: 'p1', machine_id: 'm1', name: 'p1', status: 'active' }]) },
    tabs: { listByProjects: vi.fn(async () => [{ id: 't1', project_id: 'p1', name: 't1', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null }]) },
    tasks: { officeProgress },
  } as unknown as Repositories;
  app.register((a) => officeRoutes(a, repos, { simulators: { isReady: () => false } as never }), { prefix: '/office' });
  return { app, repos, officeProgress };
}

describe('GET /office/:machineId', () => {
  beforeEach(() => {
    listTmuxSessions.mockReset().mockResolvedValue(new Set(['th-t1']));
    canAccess.mockReset().mockResolvedValue(true);
  });

  it('returns the floor with alive tabs and task counts', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/office/m1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.rooms[0].tabs[0]).toMatchObject({ id: 't1', alive: true, progress: null });
    expect(body.rooms[0].tasks).toEqual({ todo: 0, doing: 1, done: 0 });
  });

  it('answers 200 with reachable: false when the machine cannot be asked', async () => {
    listTmuxSessions.mockRejectedValue(new Error('ssh: connect timed out'));
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office/m1' })).json();
    expect(body.reachable).toBe(false);
    expect(body.rooms[0].tabs[0].alive).toBe(false);
  });

  it('leaves the board out, unqueried, for someone who cannot read tasks', async () => {
    canAccess.mockResolvedValue(false);
    const { app, officeProgress } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office/m1' })).json();
    expect(officeProgress).not.toHaveBeenCalled();
    expect(body.rooms[0].tasks).toBeNull();
    expect(canAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'u1' }), 'tasks', 'read');
  });

  it('is 404 for a machine outside the scope and for an unknown one', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/office/m2' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/office/nope' })).statusCode).toBe(404);
  });
});
