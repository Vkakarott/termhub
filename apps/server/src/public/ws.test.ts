import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Project, Tab, User } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { publicBus } from './bus.js';
import { publicId, publicRoomId } from './public-id.js';

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

// Pedro owns m1 and m3; mB is somebody else's machine that p1 happens to be linked to (merge
// ruling 2: it must never show). p1 runs on all three, so it has a room on m1 and one on m3.
const machinesOfPedro = [
  { id: 'm1', name: 'M1', owner_id: 'u1' },
  { id: 'm3', name: 'M3', owner_id: 'u1' },
];
const links = [
  { project_id: 'p1', machine_id: 'm1' },
  { project_id: 'p1', machine_id: 'm3' },
  { project_id: 'p1', machine_id: 'mB' },
  { project_id: 'p2', machine_id: 'm1' },
  { project_id: 'p3', machine_id: 'm1' },
];

const tab = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 't1',
    project_id: 'p1',
    machine_id: 'm1',
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
  let repos: {
    users: { findByNickname: ReturnType<typeof vi.fn> };
    projects: { list: ReturnType<typeof vi.fn> };
    machines: { list: ReturnType<typeof vi.fn> };
    projectMachines: { listByProjects: ReturnType<typeof vi.fn> };
  };
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
      machines: { list: vi.fn(async () => machinesOfPedro) },
      projectMachines: { listByProjects: vi.fn(async (ids: string[]) => links.filter((l) => ids.includes(l.project_id))) },
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

  // Merge ruling 2: a room is (published project, machine the owner owns); the robots of one
  // project on two machines are two rooms, each frame naming its own.
  it('splits one project\'s robots per (project, machine) room', async () => {
    const client = await connect('/ws/public/pedro');
    monitorBus.publish({ tab: tab({ id: 't1', machine_id: 'm1' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    const onM1 = await nextMessage(client);
    monitorBus.publish({ tab: tab({ id: 't7', machine_id: 'm3' }), project_id: 'p1', machine_id: 'm3', owner_id: 'u1' });
    const onM3 = await nextMessage(client);
    expect(onM1).toMatchObject({ building: publicId('machine', 'm1'), room: publicRoomId('p1', 'm1') });
    expect(onM3).toMatchObject({ building: publicId('machine', 'm3'), room: publicRoomId('p1', 'm3') });
    expect(onM1.room).not.toBe(onM3.room);
    client.terminate();
  });

  it('never sends a published project\'s robot that runs on a machine its owner does not own', async () => {
    const client = await connect('/ws/public/pedro');
    // as the monitor would publish it (the machine's owner), and even as if it claimed pedro's:
    // the pair (p1, mB) is not a room of this city
    monitorBus.publish({ tab: tab({ id: 't8', machine_id: 'mB' }), project_id: 'p1', machine_id: 'mB', owner_id: 'u2' });
    monitorBus.publish({ tab: tab({ id: 't8', machine_id: 'mB' }), project_id: 'p1', machine_id: 'mB', owner_id: 'u1' });
    await expect(nextMessage(client, { timeoutMs: 300 })).rejects.toThrow(/timeout/);
    client.terminate();
  });

  // Merge ruling 4: a machine that changes owner (or is deleted) leaves the city without anything
  // being unpublished; the page watching it is hung up so it re-reads a snapshot without it.
  it('closes the socket when a building of this city leaves the street, not when another does', async () => {
    const client = await connect('/ws/public/pedro');
    let isClosed = false;
    client.on('close', () => (isClosed = true));
    publicBus.publishRoomsGone({ machine_id: 'mB' }); // never a building of this city
    publicBus.publishRoomsGone({ machine_id: 'm1', project_id: 'p2' }); // a private project unlinked
    await new Promise((r) => setTimeout(r, 100));
    expect(isClosed).toBe(false);
    publicBus.publishRoomsGone({ machine_id: 'm3' });
    await vi.waitFor(() => expect(isClosed).toBe(true));
  });

  it('closes the socket when a published project is unlinked from one of its buildings', async () => {
    const client = await connect('/ws/public/pedro');
    const wentClosed = closed(client);
    publicBus.publishRoomsGone({ machine_id: 'm3', project_id: 'p1' });
    await expect(wentClosed).resolves.toBe(true);
  });

  it('refuses a nickname whose published projects sit only on other people\'s machines', async () => {
    repos.projectMachines.listByProjects.mockImplementation(async () => [{ project_id: 'p1', machine_id: 'mB' }]);
    await expect(connect('/ws/public/pedro')).rejects.toThrow(/404/);
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
    expect(frame.room).toBe(publicRoomId('p1', 'm1'));
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
        machines: { list: async () => [{ id: 'm1', name: 'M', owner_id: 'u1' }] },
        projects: { list: async () => [p1] },
        projectMachines: { listByProjects: async () => [{ project_id: 'p1', machine_id: 'm1' }] },
        tabs: { listByProjectsOnMachine: async () => [t] },
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

  it('tells the visitor a tab of a published room is gone, by its public id only', async () => {
    const client = await connect('/ws/public/pedro');
    publicBus.publishTabRemoved({ tab_id: 't9', project_id: 'p2', machine_id: 'm1' }); // a private room: nothing
    publicBus.publishTabRemoved({ tab_id: 't1', project_id: 'p1', machine_id: 'm1' });
    const frame = await nextMessage(client);
    expect(frame).toEqual({ type: 'robot_gone', building: publicId('machine', 'm1'), room: publicRoomId('p1', 'm1'), robot: publicId('tab', 't1') });
    await expect(nextMessage(client, { timeoutMs: 200 })).rejects.toThrow(/timeout/);
    client.terminate();
  });

  // The slot is taken before the nickname lookups: a visitor who resets the connection while they
  // are pending must give it back, or enough of them leave every later visitor with a 503.
  for (const stage of ['findByNickname', 'projects.list'] as const) {
    it(`releases the slot of a visitor who resets the connection during ${stage}, and the process survives`, async () => {
      let entered!: () => void;
      const enteredP = new Promise<void>((r) => (entered = r));
      let proceed!: () => void;
      const go = new Promise<void>((r) => (proceed = r));
      const slow = <T>(value: T) => async () => {
        entered();
        await go;
        return value;
      };
      if (stage === 'findByNickname') repos.users.findByNickname.mockImplementationOnce(slow(pedro));
      else repos.projects.list.mockImplementationOnce(slow([p1, p2, p3]));
      await start({ maxSockets: 1 });
      const onUncaught = vi.fn();
      process.on('uncaughtException', onUncaught);
      try {
        const client = net.connect(port, '127.0.0.1', () => {
          client.write(
            `GET /ws/public/pedro HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
          );
        });
        client.on('error', () => {});
        await enteredP;
        const gone = new Promise((r) => client.on('close', r));
        client.resetAndDestroy();
        await gone;
        await new Promise((r) => setTimeout(r, 50)); // the server sees the RST while the lookup is pending
        proceed();
        await new Promise((r) => setTimeout(r, 50));
        expect(onUncaught).not.toHaveBeenCalled();
      } finally {
        process.off('uncaughtException', onUncaught);
      }
      // the only slot is free again: a real visitor gets in, not a 503
      const a = await connect('/ws/public/pedro');
      a.terminate();
    });
  }
});
