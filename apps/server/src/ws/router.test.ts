import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthContext } from '../auth/index.js';
import { createUpgradeRouter } from './router.js';

const { resolveUserMock, canAccessMock } = vi.hoisted(() => ({ resolveUserMock: vi.fn(), canAccessMock: vi.fn() }));

// `resolveUser` de fato bate no banco/serviço de sessão — para o roteador só interessa o
// resultado (User | null), então mockamos o módulo inteiro e controlamos o retorno por teste.
// `parseCookies` fica com uma implementação real mínima (não é usada pelas rotas deste teste,
// mas o roteador chama incondicionalmente antes de resolveUser).
// The permission check hits the roles repository; the router only cares that it is consulted.
vi.mock('../auth/permissions.js', () => ({ canAccess: (...args: unknown[]) => canAccessMock(...args) }));

vi.mock('../auth/index.js', () => ({
  parseCookies: (header?: string) => {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
    return out;
  },
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
}));

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

interface Outcome {
  statusCode?: number;
  opened?: boolean;
  firstMessage?: string;
}

/** Tenta o handshake e resolve com o status HTTP (upgrade rejeitado) ou com a 1ª mensagem (aberto). */
function attempt(url: string, options?: WebSocket.ClientOptions): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout esperando resposta do upgrade'));
    }, 2000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      ws.terminate();
      resolve({ statusCode: res.statusCode });
    });
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve({ opened: true, firstMessage: data.toString() });
      ws.close();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('createUpgradeRouter', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    resolveUserMock.mockReset();
    canAccessMock.mockReset();
    canAccessMock.mockResolvedValue(true);
    server = http.createServer();
    const router = createUpgradeRouter(server, { auth: {} as AuthContext });
    wss = new WebSocketServer({ noServer: true });
    router.add(/^\/ws\/ok\/([a-z0-9]+)$/, ({ req, socket, head, params }) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
        ws.send(params[0]);
      });
    });
    port = await listen(server);
  });

  afterEach(async () => {
    wss.close();
    await shutdown(server);
  });

  it('path desconhecido → 404 (mesmo com origem e auth válidas)', async () => {
    resolveUserMock.mockResolvedValue({ id: 'u1' });
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/nope`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(outcome.statusCode).toBe(404);
    expect(resolveUserMock).not.toHaveBeenCalled();
  });

  it('origem de outro host → 403', async () => {
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: 'https://evil.example' } });
    expect(outcome.statusCode).toBe(403);
    expect(resolveUserMock).not.toHaveBeenCalled();
  });

  it('origem malformada → 403', async () => {
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: 'not a url' } });
    expect(outcome.statusCode).toBe(403);
  });

  it('usuário sem terminals:read → 403', async () => {
    resolveUserMock.mockResolvedValue({ id: 'u1' });
    canAccessMock.mockResolvedValue(false);
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(outcome.statusCode).toBe(403);
    expect(canAccessMock).toHaveBeenCalledWith(undefined, { id: 'u1' }, 'terminals', 'read');
  });

  it('origem válida, resolveUser sem usuário → 401', async () => {
    resolveUserMock.mockResolvedValue(null);
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(outcome.statusCode).toBe(401);
  });

  it('origem válida, resolveUser com usuário → abre e entrega o handler com o param casado', async () => {
    resolveUserMock.mockResolvedValue({ id: 'u1' });
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(outcome.opened).toBe(true);
    expect(outcome.firstMessage).toBe('abc123');
  });

  it('sem header Origin (cliente não-navegador), sem usuário → 401', async () => {
    resolveUserMock.mockResolvedValue(null);
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`);
    expect(outcome.statusCode).toBe(401);
  });

  it('sem header Origin (cliente não-navegador), com usuário → abre', async () => {
    resolveUserMock.mockResolvedValue({ id: 'u1' });
    const outcome = await attempt(`ws://127.0.0.1:${port}/ws/ok/abc123`);
    expect(outcome.opened).toBe(true);
    expect(outcome.firstMessage).toBe('abc123');
  });
});
