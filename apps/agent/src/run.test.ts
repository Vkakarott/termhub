import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type RawData } from 'ws';
import { CLOSE, CONTROL_CHANNEL, decodeFrame, helloMessage } from '@termhub/agent-protocol';
import { checkServerConnection } from './run.js';

const TOKEN = 'thb_ag_' + 'a'.repeat(43);

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

interface TestServer {
  port: number;
  hellos: unknown[];
  stop(): Promise<void>;
}

type Reply = { close: { code: number; reason: string } } | { rejectStatus: number } | { silent: true };

/** A fake termhub server: records every hello it gets and answers it as `reply` says. */
function startServer(reply: Reply): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const hellos: unknown[] = [];
    const wss = new WebSocketServer({
      server,
      verifyClient: (_info, done) => {
        if ('rejectStatus' in reply) done(false, reply.rejectStatus, http.STATUS_CODES[reply.rejectStatus] ?? 'Rejected');
        else done(true);
      },
    });
    wss.on('connection', (ws) => {
      ws.once('message', (data) => {
        const { ch, payload } = decodeFrame(asBuffer(data));
        if (ch === CONTROL_CHANNEL) hellos.push(JSON.parse(payload.toString('utf8')));
        if ('close' in reply) ws.close(reply.close.code, reply.close.reason);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        hellos,
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

describe('checkServerConnection', () => {
  let srv: TestServer | undefined;

  afterEach(async () => {
    await srv?.stop();
    srv = undefined;
  });

  it('sends a probe hello and reports ok when the server answers 1000 "probe-ok"', async () => {
    srv = await startServer({ close: { code: 1000, reason: 'probe-ok' } });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result).toEqual({ ok: true });
    expect(srv.hellos).toHaveLength(1);
    expect(helloMessage.parse(srv.hellos[0]).probe).toBe(true);
  });

  it('reports the revoked-token message on an HTTP 401 upgrade rejection', async () => {
    srv = await startServer({ rejectStatus: 401 });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result).toEqual({ ok: false, error: 'Token inválido ou revogado' });
  });

  it('reports the revoked-token message on a 4401 close after the hello', async () => {
    srv = await startServer({ close: { code: CLOSE.UNAUTHORIZED, reason: 'revoked' } });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result).toEqual({ ok: false, error: 'Token inválido ou revogado' });
  });

  it('reports the upgrade message on a 4409 "protocol" close', async () => {
    srv = await startServer({ close: { code: CLOSE.CONFLICT, reason: 'protocol' } });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Atualize o agente');
  });

  it('reports not ok when the server closes with anything else', async () => {
    srv = await startServer({ close: { code: 1011, reason: 'boom' } });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN });
    expect(result.ok).toBe(false);
  });

  it('gives up (not ok) after the timeout when the server never answers the probe', async () => {
    srv = await startServer({ silent: true });
    const result = await checkServerConnection({ url: `http://127.0.0.1:${srv.port}`, token: TOKEN }, 200);
    expect(result.ok).toBe(false);
    expect(srv.hellos).toHaveLength(1);
  });
});
