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
import { publicId } from './city.js';
import { registerPublicWs } from './ws.js';

const pedro = { id: 'u1', nickname: 'pedro' } as User;
const p1 = { id: 'p1', is_public: true, status: 'active' } as Project;

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

  function connect(path: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
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
      projects: { list: vi.fn(async () => [p1]) },
    };
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    registerPublicWs(router, { repos: repos as unknown as Repositories, log: fakeLog() });
    port = await listen(server);
  });

  afterEach(async () => {
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
});
