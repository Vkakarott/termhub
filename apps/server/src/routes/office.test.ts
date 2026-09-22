import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';

const probe = vi.fn();
const canAccess = vi.fn();
vi.mock('../terminal/machine-exec.js', () => ({ probeTmuxSessionsCached: (...a: unknown[]) => probe(...a) }));
vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: (...a: unknown[]) => canAccess(...a) }));

const { officeRoutes } = await import('./office.js');

interface LogLine {
  level: number;
  msg: string;
  [key: string]: unknown;
}
const LEVEL = { debug: 20, info: 30, warn: 40 };

function buildApp() {
  const logs: LogLine[] = [];
  const app = Fastify({ logger: { level: 'debug', stream: { write: (s: string) => void logs.push(JSON.parse(s) as LogLine) } } });
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const officeProgress = vi.fn(async () => ({ counts: { p1: { todo: 0, doing: 1, done: 0 } }, byTab: {} }));
  const repos = {
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? { id: 'm1', name: 'jarvis', owner_id: 'u1' } : id === 'm2' ? { id: 'm2', name: 'other', owner_id: 'someone-else' } : undefined)) },
    projects: { list: vi.fn(async () => [{ id: 'p1', owner_id: 'u1', name: 'p1', status: 'active' }]) },
    tabs: { listByProjectsOnMachine: vi.fn(async () => [{ id: 't1', project_id: 'p1', machine_id: 'm1', name: 't1', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null }]) },
    tasks: { officeProgress },
  } as unknown as Repositories;
  app.register((a) => officeRoutes(a, repos, { simulators: { isReady: () => false } as never }), { prefix: '/office' });
  return { app, repos, officeProgress, logs };
}

describe('GET /office/:machineId', () => {
  beforeEach(() => {
    probe.mockReset().mockResolvedValue({ reachable: true, sessions: new Set(['th-t1']) });
    canAccess.mockReset().mockResolvedValue(true);
  });

  it('returns the floor with alive tabs and task counts', async () => {
    const { app, repos } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/office/m1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.rooms[0].tabs[0]).toMatchObject({ id: 't1', alive: true, progress: null });
    expect(body.rooms[0].tasks).toEqual({ todo: 0, doing: 1, done: 0 });
    expect(repos.tabs.listByProjectsOnMachine).toHaveBeenCalledWith(['p1'], 'm1');
  });

  // The probe never throws for the ways a machine really goes silent (offline agent, ssh timeout,
  // non-zero exit): it answers `reachable: false`, and that is what has to reach the snapshot.
  it('answers 200 with reachable: false when the probe could not ask the machine', async () => {
    probe.mockResolvedValue({ reachable: false, sessions: new Set(), cause: 'timeout' });
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office/m1' })).json();
    expect(body.reachable).toBe(false);
    expect(body.rooms[0].tabs[0].alive).toBe(false);
  });

  it('logs the unreachable cause as metadata only, and the snapshot line at debug', async () => {
    probe.mockResolvedValue({ reachable: false, sessions: new Set(), cause: 'exit 255' });
    const { app, logs } = buildApp();
    await app.inject({ method: 'GET', url: '/office/m1' });
    const warning = logs.find((l) => l.msg === 'office: machine unreachable');
    expect(warning).toMatchObject({ level: LEVEL.warn, machineId: 'm1', cause: 'exit 255' });
    // one snapshot read per browser tab per minute: not worth an info line
    expect(logs.find((l) => l.msg === 'office: snapshot')).toMatchObject({ level: LEVEL.debug });
  });

  it('never asks the machine when the floor has no terminal tab', async () => {
    const { app, repos } = buildApp();
    vi.mocked(repos.tabs.listByProjectsOnMachine).mockResolvedValue([{ id: 's1', project_id: 'p1', machine_id: 'm1', name: 's1', kind: 'simulator', tmux_session: null, simulator_udid: 'u1' }] as never);
    const body = (await app.inject({ method: 'GET', url: '/office/m1' })).json();
    expect(probe).not.toHaveBeenCalled();
    expect(body.reachable).toBe(true);
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

  it('asks for a fresh probe only when ?fresh=1', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'GET', url: '/office/m1' });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm1' }), { fresh: false });
    await app.inject({ method: 'GET', url: '/office/m1?fresh=1' });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm1' }), { fresh: true });
  });

  it('rejects a malformed fresh value', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/office/m1?fresh=yes' })).statusCode).toBe(400);
  });
});
