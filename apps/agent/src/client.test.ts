import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { CLOSE, CONTROL_CHANNEL, PROTOCOL_VERSION, decodeFrame, encodeFrame, helloMessage } from '@termhub/agent-protocol';
import {
  connectOnce,
  nextBackoff,
  runForever,
  RevokedError,
  ProtocolMismatchError,
  UpgradeRejectedError,
  type ClientOptions,
} from './client.js';

const TOKEN = 'thb_ag_' + 'a'.repeat(43);

const baseHello: ClientOptions['hello'] = {
  agent_version: '0.1.0',
  os: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  tmux: false,
  tools: [],
};

const noopLog = (): ((msg: string, meta?: object) => void) => () => {};

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

interface AuthCapture {
  value?: string;
}

interface TestServer {
  port: number;
  stop(): Promise<void>;
}

function startServer(opts: {
  acceptAll?: boolean;
  /** When set, always rejects the upgrade with this HTTP status, ignoring the token (simulates the real server's 401 on a bad/unknown token). */
  rejectStatus?: number;
  capture?: AuthCapture;
  onConnection?: (ws: WebSocket) => void;
  onVerify?: () => void;
}): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({
      server,
      verifyClient: (info, done) => {
        opts.onVerify?.();
        if (opts.capture) opts.capture.value = info.req.headers.authorization;
        if (opts.rejectStatus !== undefined) {
          done(false, opts.rejectStatus, http.STATUS_CODES[opts.rejectStatus] ?? 'Rejected');
          return;
        }
        if (opts.acceptAll) {
          done(true);
          return;
        }
        done(info.req.headers.authorization === `Bearer ${TOKEN}`);
      },
    });
    wss.on('connection', (ws) => opts.onConnection?.(ws));
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        stop: () =>
          new Promise((res) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

function base(srv: TestServer): string {
  return `http://127.0.0.1:${srv.port}`;
}

describe('connectOnce', () => {
  let srv: TestServer | undefined;

  afterEach(async () => {
    await srv?.stop();
    srv = undefined;
  });

  it('sends the bearer token and the first frame is a hello with protocol 1', async () => {
    const capture: AuthCapture = {};
    let resolveFrame!: (buf: Buffer) => void;
    const framePromise = new Promise<Buffer>((res) => (resolveFrame = res));
    srv = await startServer({
      capture,
      onConnection: (ws) => {
        ws.once('message', (data) => resolveFrame(asBuffer(data)));
      },
    });

    const { closed } = await connectOnce({
      url: base(srv),
      token: TOKEN,
      hello: baseHello,
      onServerMessage: () => {},
      onStream: () => {},
      log: noopLog(),
    });
    closed.catch(() => {});

    expect(capture.value).toBe(`Bearer ${TOKEN}`);
    const raw = await framePromise;
    const { ch, payload } = decodeFrame(raw);
    expect(ch).toBe(CONTROL_CHANNEL);
    const msg = helloMessage.parse(JSON.parse(payload.toString('utf8')));
    expect(msg).toMatchObject({ type: 'hello', protocol: PROTOCOL_VERSION, ...baseHello });
  });

  it('calls onConnect once the session is up', async () => {
    srv = await startServer({ acceptAll: true });
    let connected = 0;

    const { closed } = await connectOnce({
      url: base(srv),
      token: TOKEN,
      hello: baseHello,
      onServerMessage: () => {},
      onStream: () => {},
      onConnect: () => {
        connected += 1;
      },
      log: noopLog(),
    });
    closed.catch(() => {});

    expect(connected).toBe(1);
  });

  it('rejects with UpgradeRejectedError(401) when the server rejects the upgrade (bad token)', async () => {
    srv = await startServer({});
    const attempt = connectOnce({
      url: base(srv),
      token: 'thb_ag_' + 'z'.repeat(43),
      hello: baseHello,
      onServerMessage: () => {},
      onStream: () => {},
      log: noopLog(),
    });
    await expect(attempt).rejects.toThrow(UpgradeRejectedError);
    await attempt.catch((err) => {
      expect(err).toBeInstanceOf(UpgradeRejectedError);
      expect((err as UpgradeRejectedError).status).toBe(401);
    });
  });

  it('closed resolves {code: 4401} when the server closes with 4401', async () => {
    srv = await startServer({
      onConnection: (ws) => ws.close(CLOSE.UNAUTHORIZED, 'revoked'),
    });

    const { closed } = await connectOnce({
      url: base(srv),
      token: TOKEN,
      hello: baseHello,
      onServerMessage: () => {},
      onStream: () => {},
      log: noopLog(),
    });
    const info = await closed;
    expect(info.code).toBe(CLOSE.UNAUTHORIZED);
  });

  it('dispatches channel 0 to onServerMessage and channel n to onStream', async () => {
    let resolveOpened!: (ws: WebSocket) => void;
    const openedWs = new Promise<WebSocket>((res) => (resolveOpened = res));
    srv = await startServer({ onConnection: (ws) => resolveOpened(ws) });

    const serverMessages: unknown[] = [];
    const streamChunks: { ch: number; data: Buffer }[] = [];
    const { closed } = await connectOnce({
      url: base(srv),
      token: TOKEN,
      hello: baseHello,
      onServerMessage: (msg) => serverMessages.push(msg),
      onStream: (ch, data) => streamChunks.push({ ch, data }),
      log: noopLog(),
    });
    closed.catch(() => {});

    const serverWs = await openedWs;
    serverWs.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify({ type: 'rpc', id: 'r1', method: 'tmux.list', params: {} })));
    serverWs.send(encodeFrame(3, Buffer.from('hello pty')));

    await new Promise((r) => setTimeout(r, 30));
    expect(serverMessages).toEqual([{ type: 'rpc', id: 'r1', method: 'tmux.list', params: {} }]);
    expect(streamChunks).toEqual([{ ch: 3, data: Buffer.from('hello pty') }]);
  });
});

describe('connectOnce — liveness ping', () => {
  let srv: TestServer | undefined;

  afterEach(async () => {
    await srv?.stop();
    srv = undefined;
  });

  it('terminates the socket when two pings in a row go unanswered', async () => {
    let serverSawClose: Promise<number> | undefined;
    srv = await startServer({
      onConnection: (ws) => {
        // ws auto-answers pings with pongs from its receiver via the public pong(); a server
        // whose pong never leaves (dead TCP path, half-open NAT) looks exactly like this.
        ws.pong = () => {};
        serverSawClose = new Promise((res) => ws.on('close', (code) => res(code)));
      },
    });

    const { closed } = await connectOnce({
      url: base(srv),
      token: TOKEN,
      hello: baseHello,
      onServerMessage: () => {},
      onStream: () => {},
      log: noopLog(),
      pingIntervalMs: 50,
    });

    const startedAt = Date.now();
    const info = await closed;
    expect(info.code).toBe(1006);
    // Two intervals: the first ping goes out, the second tick finds no pong and terminates.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await expect(serverSawClose!).resolves.toEqual(expect.any(Number));
  });

  it('keeps the socket open while pongs keep coming back', async () => {
    srv = await startServer({});
    let settled = false;
    const { closed } = await connectOnce({
      url: base(srv),
      token: TOKEN,
      hello: baseHello,
      onServerMessage: () => {},
      onStream: () => {},
      log: noopLog(),
      pingIntervalMs: 30,
    });
    void closed.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 200)); // > 6 ping intervals
    expect(settled).toBe(false);
  });
});

describe('runForever', () => {
  let srv: TestServer | undefined;

  afterEach(async () => {
    await srv?.stop();
    srv = undefined;
  });

  it('rejects with RevokedError after exactly maxUnauthorized consecutive 4401 closes', async () => {
    let attempts = 0;
    srv = await startServer({
      onConnection: (ws) => {
        attempts += 1;
        ws.close(CLOSE.UNAUTHORIZED, 'revoked');
      },
    });

    await expect(
      runForever({
        url: base(srv),
        token: TOKEN,
        hello: baseHello,
        onServerMessage: () => {},
        onStream: () => {},
        log: noopLog(),
        backoff: { minMs: 5, maxMs: 20 },
        maxUnauthorized: 3,
      }),
    ).rejects.toThrow(RevokedError);

    expect(attempts).toBe(3);
  });

  it('rejects with RevokedError after exactly maxUnauthorized consecutive HTTP 401 upgrade rejections', async () => {
    let attempts = 0;
    srv = await startServer({
      rejectStatus: 401,
      onVerify: () => {
        attempts += 1;
      },
    });

    await expect(
      runForever({
        url: base(srv),
        token: TOKEN,
        hello: baseHello,
        onServerMessage: () => {},
        onStream: () => {},
        log: noopLog(),
        backoff: { minMs: 5, maxMs: 20 },
        maxUnauthorized: 3,
      }),
    ).rejects.toThrow(RevokedError);

    expect(attempts).toBe(3);
  });

  it('throws ProtocolMismatchError on a 4409 protocol close, without retrying', async () => {
    let attempts = 0;
    srv = await startServer({
      onConnection: (ws) => {
        attempts += 1;
        ws.close(CLOSE.CONFLICT, 'protocol');
      },
    });

    await expect(
      runForever({
        url: base(srv),
        token: TOKEN,
        hello: baseHello,
        onServerMessage: () => {},
        onStream: () => {},
        log: noopLog(),
        backoff: { minMs: 5, maxMs: 20 },
      }),
    ).rejects.toThrow(ProtocolMismatchError);

    expect(attempts).toBe(1);
  });

  it('keeps retrying (not RevokedError) on 4409 replaced closes', async () => {
    let attempts = 0;
    srv = await startServer({
      onConnection: (ws) => {
        attempts += 1;
        ws.close(CLOSE.CONFLICT, 'replaced');
      },
    });

    const controller = new AbortController();
    const done = runForever(
      {
        url: base(srv),
        token: TOKEN,
        hello: baseHello,
        onServerMessage: () => {},
        onStream: () => {},
        log: noopLog(),
        backoff: { minMs: 5, maxMs: 10 },
      },
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(attempts).toBeGreaterThan(1);
  });

  it('stops reconnecting once the AbortSignal fires', async () => {
    // Abort from inside the server's connection handler, on the 3rd connection, rather than after
    // a wall-clock delay: an abort that lands mid-handshake terminates the client socket, but the
    // upgrade request it already sent can still reach the server (and count as a connection)
    // after runForever() has resolved. Aborting here means no other attempt is in flight, so any
    // connection seen after `done` resolves is a genuine reconnect.
    const ABORT_AT = 3;
    let attempts = 0;
    const controller = new AbortController();
    srv = await startServer({
      onConnection: (ws) => {
        attempts += 1;
        if (attempts === ABORT_AT) controller.abort();
        ws.close(1000, 'bye');
      },
    });

    const done = runForever(
      {
        url: base(srv),
        token: TOKEN,
        hello: baseHello,
        onServerMessage: () => {},
        onStream: () => {},
        log: noopLog(),
        backoff: { minMs: 5, maxMs: 10 },
      },
      controller.signal,
    );
    await expect(done).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 40));
    expect(attempts).toBe(ABORT_AT);
  });

  it('aborts a live (never-closed-by-server) session promptly instead of waiting for the server', async () => {
    let resolveServerSawClose!: (code: number) => void;
    const serverSawClose = new Promise<number>((res) => (resolveServerSawClose = res));
    srv = await startServer({
      onConnection: (ws) => {
        // The server never closes this connection on its own — only an aborted client should end it.
        ws.on('close', (code) => resolveServerSawClose(code));
      },
    });

    const controller = new AbortController();
    const done = runForever(
      {
        url: base(srv),
        token: TOKEN,
        hello: baseHello,
        onServerMessage: () => {},
        onStream: () => {},
        log: noopLog(),
        backoff: { minMs: 5, maxMs: 20 },
      },
      controller.signal,
    );

    // Give the WebSocket time to open and the hello to go out before aborting mid-session.
    await new Promise((r) => setTimeout(r, 50));
    const abortedAt = Date.now();
    controller.abort();

    await expect(done).resolves.toBeUndefined();
    expect(Date.now() - abortedAt).toBeLessThan(500);
    await expect(serverSawClose).resolves.toEqual(expect.any(Number));
  });
});

describe('nextBackoff', () => {
  it('doubles with no jitter (rand = 0.5)', () => {
    expect(nextBackoff(1000, 1000, 30000, () => 0.5)).toBe(2000);
  });

  it('caps at max', () => {
    expect(nextBackoff(20000, 1000, 30000, () => 0.5)).toBe(30000);
  });

  it('applies jitter within ±20 %', () => {
    const base2000 = Math.min(2000 * 2, 30000);
    expect(nextBackoff(2000, 1000, 30000, () => 0)).toBeCloseTo(base2000 * 0.8, 5);
    expect(nextBackoff(2000, 1000, 30000, () => 1)).toBeCloseTo(base2000 * 1.2, 5);
  });

  it('never returns below min or above max', () => {
    expect(nextBackoff(10, 1000, 30000, () => 0)).toBeGreaterThanOrEqual(1000);
    expect(nextBackoff(100000, 1000, 30000, () => 1)).toBeLessThanOrEqual(30000);
  });
});
