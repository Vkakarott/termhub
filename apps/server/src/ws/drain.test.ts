import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { closeSockets, createLifecycle, drain, readinessCheck, RESTART_CLOSE } from './drain.js';

async function listening() {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { wss, server, port: (server.address() as AddressInfo).port };
}

async function serverWithClient() {
  const { wss, server, port } = await listening();
  const client = new WebSocket(`ws://127.0.0.1:${port}/`);
  const closed = new Promise<{ code: number; reason: string }>((r) => client.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  await new Promise((r) => client.on('open', r));
  return { wss, server, client, closed };
}

/** A client that completes the HTTP upgrade by hand and then never answers anything, the close frame included. */
async function serverWithDeafClient() {
  const { wss, server, port } = await listening();
  const connected = new Promise((r) => wss.once('connection', r));
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  await new Promise((r) => raw.once('connect', r));
  raw.write(
    'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  await connected;
  return { wss, server, raw };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('closeSockets', () => {
  it('closes every client with 1012', async () => {
    const a = await serverWithClient();
    cleanups.push(() => a.server.close());
    await closeSockets([a.wss], { reason: 'service restart' });
    await expect(a.closed).resolves.toEqual({ code: RESTART_CLOSE, reason: 'service restart' });
  });

  it('closes the clients of every server given', async () => {
    const a = await serverWithClient();
    const b = await serverWithClient();
    cleanups.push(() => a.server.close(), () => b.server.close());
    await closeSockets([a.wss, b.wss]);
    await expect(a.closed).resolves.toMatchObject({ code: RESTART_CLOSE });
    await expect(b.closed).resolves.toMatchObject({ code: RESTART_CLOSE });
  });

  it('terminates sockets that do not close within the budget', async () => {
    const a = await serverWithDeafClient();
    cleanups.push(() => {
      a.raw.destroy();
      a.server.close();
    });
    expect(a.wss.clients.size).toBe(1);
    const started = Date.now();
    await closeSockets([a.wss], { budgetMs: 200 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1500);
    expect(a.wss.clients.size).toBe(0);
  });

  it('with no clients, returns at once', async () => {
    const { wss, server } = await listening();
    cleanups.push(() => server.close());
    const started = Date.now();
    await closeSockets([wss], { budgetMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('drain', () => {
  it('marks draining, suspends, closes agents before the other sockets', async () => {
    const order: string[] = [];
    const lifecycle = createLifecycle();
    const a = await serverWithClient();
    cleanups.push(() => a.server.close());
    a.client.on('close', () => order.push('socket'));
    await drain({
      lifecycle,
      suspend: async () => {
        order.push(`suspend:${lifecycle.draining}`);
      },
      closeAgents: () => {
        order.push('agents');
        return 1;
      },
      servers: [a.wss],
      log: { info: vi.fn(), warn: vi.fn() } as never,
    });
    await a.closed;
    expect(order).toEqual(['suspend:true', 'agents', 'socket']);
  });

  it('a failing suspend does not stop the rest', async () => {
    const a = await serverWithClient();
    cleanups.push(() => a.server.close());
    const closeAgents = vi.fn(() => 0);
    const warn = vi.fn();
    await drain({
      lifecycle: createLifecycle(),
      suspend: async () => {
        throw new Error('db down');
      },
      closeAgents,
      servers: [a.wss],
      log: { info: vi.fn(), warn } as never,
    });
    expect(closeAgents).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ err: 'db down' }, 'drain: suspend failed');
    await expect(a.closed).resolves.toMatchObject({ code: RESTART_CLOSE });
  });

  it('a suspend that never settles still lets the agents and sockets close, within its own budget', async () => {
    const a = await serverWithClient();
    cleanups.push(() => a.server.close());
    const closeAgents = vi.fn(() => 2);
    const warn = vi.fn();
    const started = Date.now();
    await drain({
      lifecycle: createLifecycle(),
      suspend: () => new Promise(() => {}),
      closeAgents,
      servers: [a.wss],
      log: { info: vi.fn(), warn } as never,
      suspendBudgetMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(closeAgents).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({}, 'drain: suspend budget exceeded');
    expect(warn).not.toHaveBeenCalledWith({}, 'drain: budget exceeded');
    await expect(a.closed).resolves.toMatchObject({ code: RESTART_CLOSE });
  });

  it('gives up after its budget when a step hangs', async () => {
    const warn = vi.fn();
    const lifecycle = createLifecycle();
    const started = Date.now();
    await drain({ lifecycle, suspend: () => new Promise(() => {}), closeAgents: () => 0, servers: [], log: { info: vi.fn(), warn } as never, budgetMs: 100 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(lifecycle.draining).toBe(true);
    expect(warn).toHaveBeenCalledWith({}, 'drain: budget exceeded');
  });
});

describe('readinessCheck', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('200 when the database answers and nothing drains', async () => {
    await expect(readinessCheck(async () => 1, createLifecycle())).resolves.toEqual({ status: 200, body: { ok: true } });
  });

  it('503 draining once the lifecycle drains, without asking the database', async () => {
    const lifecycle = createLifecycle();
    lifecycle.startDraining();
    const query = vi.fn(async () => 1);
    await expect(readinessCheck(query, lifecycle)).resolves.toEqual({ status: 503, body: { ok: false, reason: 'draining' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('503 database when the query rejects', async () => {
    await expect(readinessCheck(() => Promise.reject(new Error('down')), createLifecycle())).resolves.toEqual({ status: 503, body: { ok: false, reason: 'database' } });
  });

  it('503 database when the query never answers, after the timeout', async () => {
    vi.useFakeTimers();
    let settled = false;
    const result = readinessCheck(() => new Promise(() => {}), createLifecycle(), 2_000).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ status: 503, body: { ok: false, reason: 'database' } });
  });
});
