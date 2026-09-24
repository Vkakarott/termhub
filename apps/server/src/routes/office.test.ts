import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { publicId } from '../public/public-id.js';

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

const MACHINES = [
  { id: 'm1', name: 'jarvis', subtitle: 'MacBook do escritório', type: 'agent', owner_id: 'u1', host: '10.0.0.9' },
  { id: 'm2', name: 'friday', subtitle: null, type: 'ssh', owner_id: 'u1', host: '10.0.0.10' },
];
const PROJECTS = [
  { id: 'p1', owner_id: 'u1', name: 'p1', status: 'active' },
  { id: 'p2', owner_id: 'u1', name: 'p2', status: 'active' },
  { id: 'pz', owner_id: 'u1', name: 'pz', status: 'archived' },
];
type TabRow = { id: string; project_id: string; machine_id: string; name: string; kind: string; tmux_session: string | null; simulator_udid: string | null };
const TABS: TabRow[] = [
  { id: 't1', project_id: 'p1', machine_id: 'm1', name: 't1', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null },
  { id: 't2', project_id: 'p1', machine_id: 'm2', name: 't2', kind: 'terminal', tmux_session: 'th-t2', simulator_udid: null },
  // p1 also runs on a machine outside this scope (a cross-owner link): not a desk here
  { id: 'tX', project_id: 'p1', machine_id: 'mX', name: 'tX', kind: 'terminal', tmux_session: 'th-tX', simulator_udid: null },
];

function buildApp(opts: { tabs?: TabRow[]; agentOnline?: boolean } = {}) {
  const logs: LogLine[] = [];
  const app = Fastify({ logger: { level: 'debug', stream: { write: (s: string) => void logs.push(JSON.parse(s) as LogLine) } } });
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const officeProgress = vi.fn(async () => ({ counts: { p1: { todo: 0, doing: 1, done: 0 } }, byTab: {} }));
  const repos = {
    projects: { list: vi.fn(async () => PROJECTS) },
    machines: { list: vi.fn(async () => MACHINES) },
    tabs: { listByProjects: vi.fn(async () => opts.tabs ?? TABS) },
    tasks: { officeProgress },
  } as unknown as Repositories;
  app.register((a) => officeRoutes(a, repos, { simulators: { isReady: () => false }, agents: { isOnline: () => opts.agentOnline ?? true } }), { prefix: '/office' });
  return { app, repos, officeProgress, logs };
}

describe('GET /office', () => {
  beforeEach(() => {
    probe.mockReset().mockImplementation(async (m: { id: string }) => ({ reachable: true, sessions: new Set(m.id === 'm1' ? ['th-t1'] : ['th-t2']) }));
    canAccess.mockReset().mockResolvedValue(true);
  });

  it('answers the whole city: a building per non-archived project, each with its tabs on every machine', async () => {
    const { app, repos } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/office' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projects.map((b: { project: { id: string } }) => b.project.id)).toEqual(['p1', 'p2']);
    expect(body.projects[0].tabs.map((t: { id: string; machine_id: string; alive: boolean }) => [t.id, t.machine_id, t.alive])).toEqual([['t1', 'm1', true], ['t2', 'm2', true]]);
    expect(body.projects[0].public_id).toBe(publicId('project', 'p1'));
    expect(body.projects[0].tasks).toEqual({ todo: 0, doing: 1, done: 0 });
    expect(body.projects[1].tabs).toEqual([]);
    expect(repos.tabs.listByProjects).toHaveBeenCalledWith(['p1', 'p2']);
  });

  // scoped to the caller: an admin's "view as" or a transferred machine must not bring another
  // owner's projects, machines or tabs into this city
  it('reads only the scope: its projects, its machines, and no desk on a machine outside it', async () => {
    const { app, repos } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(repos.projects.list).toHaveBeenCalledWith({ owner: 'u1' });
    expect(repos.machines.list).toHaveBeenCalledWith('u1');
    expect(body.projects[0].tabs.map((t: { id: string }) => t.id)).toEqual(['t1', 't2']);
    expect(body.machines.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
    expect(probe).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'mX' }), expect.anything());
  });

  it('describes each machine a desk runs on, field by field', async () => {
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(body.machines[0]).toEqual({ id: 'm1', name: 'jarvis', subtitle: 'MacBook do escritório', type: 'agent', online: true, reachable: true });
    expect(JSON.stringify(body)).not.toContain('10.0.0.9');
  });

  it('says an agent machine is offline from its connection', async () => {
    const { app } = buildApp({ agentOnline: false });
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(body.machines[0]).toMatchObject({ id: 'm1', online: false });
  });

  it('probes every machine with a terminal desk once, all at the same time', async () => {
    const answers: Array<() => void> = [];
    probe.mockImplementation((m: { id: string }) => new Promise((resolve) => answers.push(() => resolve({ reachable: true, sessions: new Set([m.id === 'm1' ? 'th-t1' : 'th-t2']) }))));
    const { app } = buildApp();
    const pending = app.inject({ method: 'GET', url: '/office' });
    // both asked before either answered: one slow machine does not queue the next one behind it
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    answers.forEach((answer) => answer());
    expect((await pending).statusCode).toBe(200);
  });

  // city-by-project §8: a failing probe marks the machine unreachable without failing the request
  it('answers 200 with the machine unreachable when its probe throws, the rest of the city intact', async () => {
    probe.mockImplementation(async (m: { id: string }) => {
      if (m.id === 'm2') throw new Error('boom');
      return { reachable: true, sessions: new Set(['th-t1']) };
    });
    const { app, logs } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/office' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.machines.find((m: { id: string }) => m.id === 'm2')).toMatchObject({ reachable: false, online: false });
    expect(body.projects[0].tabs.map((t: { id: string; alive: boolean }) => [t.id, t.alive])).toEqual([['t1', true], ['t2', false]]);
    expect(logs.find((l) => l.msg === 'office: machine unreachable')).toMatchObject({ level: LEVEL.warn, machineId: 'm2', cause: 'probe failed' });
  });

  // The probe never throws for the ways a machine really goes silent (offline agent, ssh timeout,
  // non-zero exit): it answers `reachable: false`, and that is what has to reach the city.
  it('reports a probe that could not ask the machine: its tabs read as not alive', async () => {
    probe.mockImplementation(async (m: { id: string }) => (m.id === 'm1' ? { reachable: false, sessions: new Set(), cause: 'timeout' } : { reachable: true, sessions: new Set(['th-t2']) }));
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(body.machines[0]).toMatchObject({ id: 'm1', reachable: false });
    expect(body.projects[0].tabs[0].alive).toBe(false);
  });

  it('logs the unreachable cause as metadata only, and the city line at debug', async () => {
    probe.mockImplementation(async (m: { id: string }) => (m.id === 'm1' ? { reachable: false, sessions: new Set(), cause: 'exit 255' } : { reachable: true, sessions: new Set() }));
    const { app, logs } = buildApp();
    await app.inject({ method: 'GET', url: '/office' });
    expect(logs.find((l) => l.msg === 'office: machine unreachable')).toMatchObject({ level: LEVEL.warn, machineId: 'm1', cause: 'exit 255' });
    // one read per browser tab per minute: not worth an info line
    expect(logs.find((l) => l.msg === 'office: city')).toMatchObject({ level: LEVEL.debug, buildings: 2, tabs: 2, machines: 2 });
  });

  it('never asks a machine that has no terminal desk', async () => {
    const { app } = buildApp({ tabs: [{ id: 's1', project_id: 'p1', machine_id: 'm1', name: 's1', kind: 'simulator', tmux_session: null, simulator_udid: 'u1' }] });
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(probe).not.toHaveBeenCalled();
    expect(body.machines).toEqual([expect.objectContaining({ id: 'm1', reachable: null })]);
  });

  it('leaves the board out, unqueried, for someone who cannot read tasks', async () => {
    canAccess.mockResolvedValue(false);
    const { app, officeProgress } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/office' })).json();
    expect(officeProgress).not.toHaveBeenCalled();
    expect(body.projects[0].tasks).toBeNull();
    expect(canAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'u1' }), 'tasks', 'read');
  });

  it('asks for a fresh probe only when ?fresh=1', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'GET', url: '/office' });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm2' }), { fresh: false });
    await app.inject({ method: 'GET', url: '/office?fresh=1' });
    expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm2' }), { fresh: true });
  });

  it('rejects a malformed fresh value', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/office?fresh=yes' })).statusCode).toBe(400);
  });

  it('no longer serves the per-machine floor', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/office/m1' })).statusCode).toBe(404);
  });
});
