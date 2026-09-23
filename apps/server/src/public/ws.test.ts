import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Project, Tab, User } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { publicBus } from './bus.js';
import { publicId } from './public-id.js';

// The tmux memo both public surfaces read (never probe). Cold by default, like a fresh process.
const { memo } = vi.hoisted(() => ({ memo: { current: undefined as { reachable: boolean; sessions: Set<string> } | undefined } }));
vi.mock('../terminal/machine-exec.js', () => ({ cachedTmuxProbe: () => memo.current }));

const { registerPublicWs } = await import('./ws.js');
const { readPublicCity } = await import('./read.js');

const pedro = { id: 'u1', nickname: 'pedro' } as User;
const p1 = { id: 'p1', is_public: true, status: 'active' } as Project;
// p2 (private) and p3 (archived) belong to the same owner as p1: present in `projects.list`, so
// a test that deletes the is_public/status filter and leaves only set membership would still pass
// unless something asserts these two are excluded (see "filters by is_public and status" below).
const p2 = { id: 'p2', is_public: false, status: 'active' } as Project;
const p3 = { id: 'p3', is_public: true, status: 'archived' } as Project;

const tab = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 't1',
    project_id: 'p1',
    name: 't1',
    kind: 'terminal',
    tmux_session: 'th-t1',
    simulator_udid: null,
    position: 0,
    state: 'working',
    state_text: null,
    state_tool: 'claude',
    state_at: '2026-09-19T10:00:00.000Z',
    state_seen_at: null,
    activity: null,
    created_at: '',
    ...over,
  }) as Tab;

function fakeLog(): FastifyBaseLogger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => log),
    level: 'info',
  };
  return log as unknown as FastifyBaseLogger;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function shutdown(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

describe('registerPublicWs', () => {
  let server: http.Server;
  let repos: { users: { findByNickname: ReturnType<typeof vi.fn> }; projects: { list: ReturnType<typeof vi.fn> } };
  let port: number;

  function connect(path: string, opts: { autoPong?: boolean } = {}): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { autoPong: opts.autoPong ?? true });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('timeout waiting for upgrade response'));
      }, 2000);
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        res.resume();
        ws.terminate();
        reject(new Error(`upgrade rejected: ${res.statusCode}`));
      });
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function nextMessage(client: WebSocket, opts: { timeoutMs?: number } = {}): Promise<{ type: string; building: string; room: string; robot: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), opts.timeoutMs ?? 500);
      client.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  function closed(client: WebSocket): Promise<boolean> {
    return new Promise((resolve) => {
      client.on('close', () => resolve(true));
    });
  }

  beforeEach(async () => {
    repos = {
      users: { findByNickname: vi.fn(async (nickname: string) => (nickname === 'pedro' ? pedro : undefined)) },
      projects: { list: vi.fn(async () => [p1, p2, p3]) },
    };
    await start();
  });

  async function start(limits?: { maxSockets?: number; heartbeatMs?: number }) {
    if (server?.listening) await shutdown(server);
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    const wss = registerPublicWs(router, { repos: repos as unknown as Repositories, log: fakeLog(), limits });
    server.on('close', () => wss.close());
    port = await listen(server);
  }

  afterEach(async () => {
    memo.current = undefined;
    if (server) await shutdown(server);
  });

  it('sends a change on a published room', async () => {
    const client = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ activity: 'reading' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    const frame = await nextMessage(client);
    expect(frame.type).toBe('robot');
    expect(frame.robot.activity).toBe('reading');
    expect(frame.robot.id).toBe(publicId('tab', 't1'));
    expect(JSON.stringify(frame)).not.toContain('th-t1');
    client.terminate();
  });

  it('never sends a change on a private room of the same machine', async () => {
    const client = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ id: 't9', project_id: 'p9' }), project_id: 'p9', machine_id: 'm1', owner_id: 'u1' });
    await expect(nextMessage(client, { timeoutMs: 300 })).rejects.toThrow(/timeout/);
    client.terminate();
  });

  it('closes the socket when the room is unpublished', async () => {
    const client = await connect('/ws/public/pedro');
    publicBus.publish({ project_id: 'p1', is_public: false });
    await expect(closed(client)).resolves.toBe(true);
  });

  it('refuses an unknown nickname', async () => {
    await expect(connect('/ws/public/ninguem')).rejects.toThrow(/404/);
  });

  it('answers 404, not 500, for a malformed percent-escape in the nickname', async () => {
    await expect(connect('/ws/public/%')).rejects.toThrow(/404/);
  });

  it('filters by is_public and status, not merely by membership in the owner\'s projects', async () => {
    const client = await connect('/ws/public/pedro');
    // p2 is private, p3 is public but archived — both belong to pedro and are returned by
    // `projects.list`, so only the predicate inside registerPublicWs keeps them out.
    monitorBus.publish({ tab: tab({ id: 't2', project_id: 'p2' }), project_id: 'p2', machine_id: 'm1', owner_id: 'u1' });
    monitorBus.publish({ tab: tab({ id: 't3', project_id: 'p3' }), project_id: 'p3', machine_id: 'm1', owner_id: 'u1' });
    monitorBus.publish({ tab: tab({ activity: 'reading' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    const frame = await nextMessage(client);
    expect(frame.room).toBe(publicId('project', 'p1'));
    expect(frame.robot.id).toBe(publicId('tab', 't1'));
    await expect(nextMessage(client, { timeoutMs: 300 })).rejects.toThrow(/timeout/);
    client.terminate();
  });

  it('reports alive from the tab\'s own state, matching the snapshot\'s cold-memo rule — not from the fact that a change arrived', async () => {
    const client = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ id: 't4', state: null }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    const asleep = await nextMessage(client);
    expect(asleep.robot.alive).toBe(false);
    monitorBus.publish({ tab: tab({ id: 't5', state: 'working' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    const awake = await nextMessage(client);
    expect(awake.robot.alive).toBe(true);
    client.terminate();
  });

  // The snapshot and the channel must never disagree about who is at a desk: with a warm memo both
  // read real tmux membership, with a cold one both fall back to the tab's own state.
  it('reports the same alive as the snapshot, warm memo or cold', async () => {
    const snapshotAlive = async (t: Tab) => {
      const snapRepos = {
        users: { findByNickname: async () => pedro },
        machines: { list: async () => [{ id: 'm1', name: 'M' }] },
        projects: { list: async () => [p1] },
        tabs: { listByProjects: async () => [t] },
      } as unknown as Repositories;
      return (await readPublicCity(snapRepos, 'pedro'))!.buildings[0]!.rooms[0]!.robots[0]!.alive;
    };
    const client = await connect('/ws/public/pedro');
    const cases: [typeof memo.current, Tab][] = [
      [{ reachable: true, sessions: new Set(['th-other']) }, tab({ state: 'working' })],
      [{ reachable: true, sessions: new Set(['th-t1']) }, tab({ state: null })],
      [{ reachable: false, sessions: new Set() }, tab({ state: 'working' })],
      [undefined, tab({ state: 'working' })],
      [undefined, tab({ state: null })],
    ];
    for (const [warm, t] of cases) {
      memo.current = warm;
      monitorBus.publish({ tab: t, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
      const frame = await nextMessage(client);
      expect(frame.robot.alive).toBe(await snapshotAlive(t));
    }
    // and the warm cases really are read from the memo, not from the tab's state
    memo.current = { reachable: true, sessions: new Set(['th-other']) };
    monitorBus.publish({ tab: tab({ state: 'working' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    expect((await nextMessage(client)).robot.alive).toBe(false);
    client.terminate();
  });

  it('does not crash the process on an oversized frame, and cleans up its subscriptions', async () => {
    const client = await connect('/ws/public/pedro');
    const listenersBefore = monitorBus.listenerCount();
    const wentClosed = closed(client);
    client.send(Buffer.alloc(8 * 1024, 0x20)); // over the 4 KiB maxPayload — a protocol violation
    await wentClosed;
    expect(monitorBus.listenerCount()).toBe(listenersBefore - 1);

    // The server process is still standing: a fresh connection still works end to end.
    const client2 = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ activity: 'reading' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    const frame = await nextMessage(client2);
    expect(frame.type).toBe('robot');
    client2.terminate();
  });

  // A half-open socket (a phone that lost signal) never says goodbye: without a heartbeat it would
  // hold its bus listeners until nginx's hour-long read timeout.
  it('drops a socket that stops answering pings, and releases its listeners', async () => {
    await start({ heartbeatMs: 50 });
    // earlier tests' sockets are torn down on the server's side a tick after their clients go
    await vi.waitFor(() => expect(monitorBus.listenerCount()).toBe(0));
    const listenersBefore = monitorBus.listenerCount();
    const client = await connect('/ws/public/pedro', { autoPong: false });
    expect(monitorBus.listenerCount()).toBe(listenersBefore + 1);
    await expect(closed(client)).resolves.toBe(true);
    // the server's own close handler runs on its side of the socket, a tick after the client's
    await vi.waitFor(() => expect(monitorBus.listenerCount()).toBe(listenersBefore));
  });

  it('keeps a socket that answers its pings', async () => {
    await start({ heartbeatMs: 50 });
    const client = await connect('/ws/public/pedro');
    await new Promise((r) => setTimeout(r, 250));
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.terminate();
  });

  it('refuses a public socket beyond the process-wide ceiling, and admits one again once a slot frees', async () => {
    await start({ maxSockets: 2 });
    const a = await connect('/ws/public/pedro');
    const b = await connect('/ws/public/pedro');
    await expect(connect('/ws/public/pedro')).rejects.toThrow(/503/);
    const gone = closed(a);
    a.close();
    await gone;
    await new Promise((r) => setTimeout(r, 20));
    const c = await connect('/ws/public/pedro');
    b.terminate();
    c.terminate();
  });

  it('does not count a refused upgrade against the ceiling', async () => {
    await start({ maxSockets: 1 });
    for (let i = 0; i < 3; i++) await expect(connect('/ws/public/ninguem')).rejects.toThrow(/404/);
    const a = await connect('/ws/public/pedro');
    a.terminate();
  });
});
