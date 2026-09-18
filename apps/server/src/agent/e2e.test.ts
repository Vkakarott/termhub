import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { newAgentToken } from './token.js';
import { registerAgentWs } from './ws.js';
import { registerTerminalWs } from '../terminal/ws.js';
import { agents } from './registry.js';
import { captureScreen } from './screen.js';
// Agent-side modules, imported straight from the sibling package's source: this suite proves
// the whole chain (browser <-> server <-> agent <-> real tmux) works end to end, so it needs
// the real agent runtime, not a mock of it. See task-15-brief.md for why this lives here
// instead of in apps/agent (the harness — real http.Server + createUpgradeRouter — is the
// server test suite's, not the agent's).
import { runAgent } from '../../../agent/src/run.js';
import type { AgentConfig } from '../../../agent/src/config.js';

const { resolveUserMock, canAccessMock } = vi.hoisted(() => ({
  resolveUserMock: vi.fn(),
  canAccessMock: vi.fn(),
}));

// Same stubbing style as terminal/ws.test.ts: the cookie/permission plumbing isn't what this
// suite is about, only the real createPtySession -> agent registry -> tmux wiring is.
vi.mock('../auth/permissions.js', () => ({ canAccess: (...args: unknown[]) => canAccessMock(...args) }));
vi.mock('../auth/index.js', () => ({
  parseCookies: () => ({}),
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));

function commandExists(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Docker runners without tmux (node.sh) must still pass green: this whole suite is a no-op
// there, proving the skip itself works rather than failing on a missing binary.
const hasTmux = commandExists('tmux');

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

describe.skipIf(!hasTmux)('agent e2e: browser <-> server <-> agent <-> real tmux', () => {
  let server: http.Server;
  let port: number;
  let tmuxTmpDir: string;
  let projectCwd: string;
  let agentController: AbortController;
  let agentRunPromise: Promise<void>;
  let machine: Machine;

  beforeAll(async () => {
    tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thtest-tmux-'));
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thtest-cwd-'));

    // Set before anything spawns tmux: the agent's own tmux calls (pty open + tmux.capture RPC)
    // build their env from process.env at call time, so this keeps the real tmux server the
    // dev/CI machine might have running completely out of reach.
    process.env.TMUX_TMPDIR = tmuxTmpDir;
    delete process.env.TMUX_PATH;

    const { token, hash } = newAgentToken();

    machine = {
      id: 'm1',
      name: 'e2e-agent',
      host: null,
      ssh_user: null,
      ssh_port: 22,
      type: 'agent',
      os: 'linux',
      capabilities: [],
      checked_at: null,
      agent_version: null,
      agent_last_seen_at: null,
      owner_id: 'u1',
      owner_name: null,
      created_at: new Date().toISOString(),
    } as unknown as Machine;

    const project: Project = {
      id: 'p1',
      machine_id: 'm1',
      name: 'e2e-project',
      cwd: projectCwd,
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
      tmux_session: 'thtest-e2e',
      simulator_udid: null,
      position: 0,
      created_at: new Date().toISOString(),
    } as unknown as Tab;

    resolveUserMock.mockResolvedValue({ id: 'u1' });
    canAccessMock.mockResolvedValue(true);

    const repos = {
      tabs: { findById: vi.fn(async () => tab) },
      projects: {
        findById: vi.fn(async () => project),
        touchTerminal: vi.fn(async () => {}),
      },
      machines: {
        findById: vi.fn(async () => machine),
        findByAgentTokenHash: vi.fn(async (h: string) => (h === hash ? machine : undefined)),
        touchAgent: vi.fn(async () => {}),
      },
    } as unknown as Repositories;

    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    registerAgentWs(router, { repos, log: fakeLog() });
    registerTerminalWs(router, { repos, log: fakeLog() });
    port = await listen(server);

    const agentConfig: AgentConfig = {
      url: `http://127.0.0.1:${port}`,
      token,
      machine_id: '',
      machine_name: '',
      created_at: new Date().toISOString(),
    };
    agentController = new AbortController();
    agentRunPromise = runAgent(agentConfig, { signal: agentController.signal, log: () => {} }).catch((err) => {
      if (!agentController.signal.aborted) throw err;
    });

    await vi.waitFor(() => expect(agents.isOnline('m1')).toBe(true), { timeout: 10_000, interval: 100 });
  });

  afterAll(async () => {
    agentController?.abort();
    await agentRunPromise?.catch(() => {});
    try {
      execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir } });
    } catch {
      /* no session left, or tmux server already gone — fine */
    }
    if (server) await shutdown(server);
    fs.rmSync(tmuxTmpDir, { recursive: true, force: true });
    fs.rmSync(projectCwd, { recursive: true, force: true });
  });

  it(
    'echoes a command through a real tmux session on the agent side',
    { timeout: 30_000 },
    async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tabs/t1?cols=80&rows=24`);
      let received = '';
      const ready = new Promise<void>((resolve, reject) => {
        ws.once('error', reject);
        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            received += Buffer.from(data as Buffer).toString('utf8');
            return;
          }
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ready') resolve();
        });
      });

      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      await ready;

      ws.send(Buffer.from('echo E2E_OK\n'), { binary: true });

      // The typed command is echoed by the pty first, then the shell prints the actual
      // output line — wait for the marker to show up twice (input echo + real output) so we
      // don't pass on the input echo alone.
      await vi.waitFor(
        () => {
          const occurrences = received.split('E2E_OK').length - 1;
          expect(occurrences).toBeGreaterThanOrEqual(2);
        },
        { timeout: 15_000, interval: 100 },
      );

      const screen = await captureScreen(machine, 'thtest-e2e', 50);
      expect(screen).toContain('E2E_OK');

      ws.close();
    },
  );
});
