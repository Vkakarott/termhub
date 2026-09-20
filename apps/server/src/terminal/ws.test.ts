import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { AgentOfflineError } from '../agent/registry.js';
import { AgentRpcError } from '../agent/connection.js';
import { registerTerminalWs } from './ws.js';

const { resolveUserMock, canAccessMock, createPtySessionMock } = vi.hoisted(() => ({
  resolveUserMock: vi.fn(),
  canAccessMock: vi.fn(),
  createPtySessionMock: vi.fn(),
}));

// The router's cookie/permission plumbing isn't what this suite is about — stub it open,
// the same way ws/router.test.ts does, and drive scenarios through createPtySession instead.
vi.mock('../auth/permissions.js', () => ({ canAccess: (...args: unknown[]) => canAccessMock(...args) }));
vi.mock('../auth/index.js', () => ({
  parseCookies: () => ({}),
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));
// Real LocalPtySession pulls in the native node-pty addon; this suite is only about the
// ws.ts <-> createPtySession wiring, so the whole module is replaced.
vi.mock('./pty-session.js', () => ({ createPtySession: (...args: unknown[]) => createPtySessionMock(...args) }));

const machine: Machine = {
  id: 'm1',
  name: 'agent-machine',
  host: null,
  ssh_user: null,
  ssh_port: 22,
  type: 'agent',
  os: 'macos',
  capabilities: [],
  checked_at: null,
  agent_version: '0.1.0',
  agent_last_seen_at: null,
  agent_auto_update: false,
  is_local: false,
  owner_id: 'u1',
} as unknown as Machine;

const project: Project = {
  id: 'p1',
  machine_id: 'm1',
  name: 'proj',
  cwd: '/Users/x/proj',
  status: 'active',
  description: null,
  last_terminal_at: null,
  created_at: new Date().toISOString(),
} as unknown as Project;

const tab: Tab = {
  id: 't1',
  project_id: 'p1',
  name: 'main',
  kind: 'terminal',
  tmux_session: 'termhub-t1',
  simulator_udid: null,
  position: 0,
  created_at: new Date().toISOString(),
} as unknown as Tab;

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

function fakeRepos(): Repositories {
  return {
    tabs: { findById: vi.fn(async () => tab) },
    projects: { findById: vi.fn(async () => project), touchTerminal: vi.fn(async () => {}) },
    machines: { findById: vi.fn(async () => machine) },
  } as unknown as Repositories;
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

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('registerTerminalWs', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    resolveUserMock.mockReset().mockResolvedValue({ id: 'u1' });
    canAccessMock.mockReset().mockResolvedValue(true);
    createPtySessionMock.mockReset();
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    wss = registerTerminalWs(router, { repos: fakeRepos(), log: fakeLog() });
    port = await listen(server);
  });

  afterEach(async () => {
    wss.close();
    await shutdown(server);
  });

  it('agent offline: client gets "Agente desconectado" and the socket closes 1011', async () => {
    createPtySessionMock.mockRejectedValueOnce(new AgentOfflineError('agent offline: m1'));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/t1`);
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await waitOpen(ws);

    const closed = await waitClose(ws);

    expect(closed.code).toBe(1011);
    expect(messages).toContainEqual({ type: 'error', message: 'Agente desconectado' });
  });

  async function openError(err: unknown): Promise<unknown[]> {
    createPtySessionMock.mockRejectedValueOnce(err);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/t1`);
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await waitOpen(ws);
    expect((await waitClose(ws)).code).toBe(1011);
    return messages;
  }

  it('the agent could not start the terminal: says what to run on the machine', async () => {
    const messages = await openError(new AgentRpcError({ code: 'internal', message: 'failed to start pty' }));
    expect(messages).toContainEqual({ type: 'error', message: 'Esta máquina não conseguiu abrir o terminal. Rode termhub-agent doctor nela.' });
  });

  it('the agent has no tmux: says so', async () => {
    const messages = await openError(new AgentRpcError({ code: 'no_tmux', message: 'tmux not found' }));
    expect(messages).toContainEqual({ type: 'error', message: 'tmux não encontrado nesta máquina. Instale o tmux e tente de novo.' });
  });

  it('any other failure keeps the generic message', async () => {
    const messages = await openError(new Error('ssh: connect refused'));
    expect(messages).toContainEqual({ type: 'error', message: 'Falha ao iniciar terminal' });
  });

  it('kills a session whose browser socket closed while createPtySession() was still pending', async () => {
    let resolveSession!: (session: unknown) => void;
    const deferred = new Promise((resolve) => {
      resolveSession = resolve;
    });
    createPtySessionMock.mockReturnValueOnce(deferred);
    const kill = vi.fn();
    const fakeSession = { write: vi.fn(), resize: vi.fn(), kill, pid: null };

    let serverWs: WebSocket | undefined;
    wss.once('connection', (sock: WebSocket) => {
      serverWs = sock;
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/t1`);
    await waitOpen(ws);

    // Wait until the server has actually started creating the session (and, by construction
    // of handleConnection, has already registered its early close/error listeners) before
    // triggering the disconnect — this is the exact race the fix has to survive.
    await vi.waitFor(() => expect(createPtySessionMock).toHaveBeenCalledTimes(1));
    expect(serverWs).toBeDefined();

    const serverSawClose = new Promise<void>((resolve) => serverWs!.once('close', () => resolve()));
    ws.close();
    await serverSawClose;

    // Only now does createPtySession() resolve — after the browser socket is already gone.
    resolveSession(fakeSession);

    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
    // No spurious extra teardown: the normal ws.on('close', ...) path never gets to run
    // because clientGone short-circuits before it's registered.
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
