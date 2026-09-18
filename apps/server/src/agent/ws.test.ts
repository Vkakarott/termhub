import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { CLOSE, CONTROL_CHANNEL, PROTOCOL_VERSION, encodeFrame } from '@termhub/agent-protocol';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { hashAgentToken } from './token.js';
import { AgentRegistry } from './registry.js';
import { registerAgentWs } from './ws.js';

const GOOD = 'thb_ag_' + 'a'.repeat(43);

const machine = { id: 'm1', name: 'mini', type: 'agent' } as unknown as Machine;

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

function open(url: string, headers?: Record<string, string>): Promise<{ ws?: WebSocket; statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout waiting for upgrade response'));
    }, 2000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      ws.terminate();
      resolve({ statusCode: res.statusCode });
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ ws });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('registerAgentWs', () => {
  let server: http.Server;
  let repos: { machines: { findByAgentTokenHash: ReturnType<typeof vi.fn>; touchAgent: ReturnType<typeof vi.fn> } };
  let registry: AgentRegistry;
  let port: number;

  function start(opts: { helloTimeoutMs?: number } = {}) {
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    registerAgentWs(router, {
      repos: repos as unknown as Repositories,
      log: fakeLog(),
      registry,
      ...opts,
    });
    return listen(server).then((p) => (port = p));
  }

  beforeEach(() => {
    repos = {
      machines: {
        findByAgentTokenHash: vi.fn(async (h: string) => (h === hashAgentToken(GOOD) ? machine : undefined)),
        touchAgent: vi.fn(async () => {}),
      },
    };
    registry = new AgentRegistry();
  });

  afterEach(async () => {
    if (server) await shutdown(server);
  });

  it('no Authorization header → 401', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`);
    expect(res.statusCode).toBe(401);
    expect(repos.machines.findByAgentTokenHash).not.toHaveBeenCalled();
  });

  it('bearer token that hashes to no machine → 401', async () => {
    await start();
    // Well-formed (matches AGENT_TOKEN_RE) but distinct from GOOD, so this actually exercises
    // the findByAgentTokenHash() miss path rather than the regex check above it.
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer thb_ag_${'b'.repeat(43)}` });
    expect(res.statusCode).toBe(401);
    expect(repos.machines.findByAgentTokenHash).toHaveBeenCalled();
  });

  it('valid token: upgrade succeeds, hello marks the machine online and touches it', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    expect(res.statusCode).toBeUndefined();
    const ws = res.ws!;
    const hello = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      agent_version: '0.1.0',
      os: 'linux',
      arch: 'x64',
      hostname: 'box',
      tmux: true,
      tools: ['tmux'],
    };
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(hello)));

    await vi.waitFor(() => expect(registry.isOnline('m1')).toBe(true));
    await vi.waitFor(() =>
      expect(repos.machines.touchAgent).toHaveBeenCalledWith('m1', {
        version: '0.1.0',
        os: 'linux',
        capabilities: ['tmux'],
        lastSeenAt: expect.any(Date),
      }),
    );
    ws.terminate();
  });

  it('valid token but no hello within the timeout → closed 1008', async () => {
    await start({ helloTimeoutMs: 200 });
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    const closed = await waitClose(ws);
    expect(closed.code).toBe(1008);
  });

  it('hello with a newer protocol version → closed 4409 "protocol"', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    const hello = {
      type: 'hello',
      protocol: 99,
      agent_version: '0.1.0',
      os: 'linux',
      arch: 'x64',
      hostname: 'box',
      tmux: true,
      tools: [],
    };
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(hello)));
    const closed = await waitClose(ws);
    expect(closed.code).toBe(CLOSE.CONFLICT);
    expect(closed.reason).toBe('protocol');
    expect(registry.isOnline('m1')).toBe(false);
  });

  const goodHello = {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    agent_version: '0.1.0',
    os: 'linux',
    arch: 'x64',
    hostname: 'box',
    tmux: true,
    tools: ['tmux'],
  };

  it('probe hello is answered with close 1000 "probe-ok" without attaching or touching', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, probe: true })));
    const closed = await waitClose(ws);
    expect(closed).toEqual({ code: 1000, reason: 'probe-ok' });
    expect(registry.isOnline('m1')).toBe(false);
    expect(repos.machines.touchAgent).not.toHaveBeenCalled();
  });

  it('a live attached connection survives a probe from the same token', async () => {
    await start();
    const live = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` })).ws!;
    const liveClosed = waitClose(live);
    live.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(goodHello)));
    await vi.waitFor(() => expect(registry.isOnline('m1')).toBe(true));

    const probe = (await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` })).ws!;
    probe.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, probe: true })));
    expect(await waitClose(probe)).toEqual({ code: 1000, reason: 'probe-ok' });

    // The probe must not have replaced (4409) the real session.
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.isOnline('m1')).toBe(true);
    expect(live.readyState).toBe(WebSocket.OPEN);
    live.terminate();
    await liveClosed;
  });

  it('probe hello with a newer protocol version is still refused with 4409 "protocol"', async () => {
    await start();
    const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
    const ws = res.ws!;
    ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ ...goodHello, protocol: 99, probe: true })));
    const closed = await waitClose(ws);
    expect(closed.code).toBe(CLOSE.CONFLICT);
    expect(closed.reason).toBe('protocol');
    expect(registry.isOnline('m1')).toBe(false);
  });

  it('connection closing while the initial touch() is still in flight leaves no dangling interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      await start();
      const res = await open(`ws://127.0.0.1:${port}/agent/ws`, { Authorization: `Bearer ${GOOD}` });
      const ws = res.ws!;

      // Hold the initial touchAgent() call pending so we can close the socket while it's
      // still in flight — the exact race the fix (registering conn.on('close', ...) before
      // the await) has to survive.
      let releaseTouch: (() => void) | undefined;
      const firstTouchCalled = new Promise<void>((resolve) => {
        repos.machines.touchAgent.mockImplementationOnce(() => {
          resolve();
          return new Promise<void>((r) => {
            releaseTouch = r;
          });
        });
      });

      const hello = {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        agent_version: '0.1.0',
        os: 'linux',
        arch: 'x64',
        hostname: 'box',
        tmux: true,
        tools: ['tmux'],
      };
      ws.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(hello)));
      await firstTouchCalled;

      const offline = new Promise<void>((resolve) => registry.once('offline', () => resolve()));
      ws.terminate();
      await offline; // server processed the close while the initial touch() was still pending

      releaseTouch?.(); // let the in-flight touch() resolve now that the connection is closed
      await vi.advanceTimersByTimeAsync(70_000); // past both the 20s heartbeat and 60s touch intervals

      expect(repos.machines.touchAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
