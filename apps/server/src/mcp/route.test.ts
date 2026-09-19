import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn() }));
vi.mock('../control/inventory.js', async (orig) => ({ ...(await orig<typeof import('../control/inventory.js')>()), listMachines: vi.fn() }));
vi.mock('../control/screen.js', async (orig) => ({ ...(await orig<typeof import('../control/screen.js')>()), readScreen: vi.fn() }));

import { canAccess } from '../auth/permissions.js';
import { listMachines } from '../control/inventory.js';
import { readScreen } from '../control/screen.js';
import { ControlError } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import { applyErrorHandler } from '../lib/errors.js';
import { hashApiToken } from '../auth/api-tokens.js';
import { mcpRoutes } from './route.js';
import { TokenRateLimiter } from './rate-limit.js';

const SECRET = 'thb_pat_' + 'A'.repeat(43);
const token = (over: Partial<ApiToken> = {}): ApiToken => ({ id: 'tok1', user_id: 'u1', name: 'jarvis', scopes: ['read'], expires_at: null, last_used_at: null, revoked_at: null, created_at: '', ...over });

function build(opts: { token?: ApiToken | undefined; grants?: string[]; limiter?: TokenRateLimiter } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  const active = 'token' in opts ? opts.token : token();
  const apiTokens = {
    findActiveByHash: vi.fn(async (hash: string) => (hash === hashApiToken(SECRET) ? active : undefined)),
    touchLastUsed: vi.fn(async () => {}),
    recordEvent: vi.fn(async () => {}),
  };
  const repos = { apiTokens, users: { findById: vi.fn(async (id: string) => (id === 'u1' ? { id: 'u1', role_id: 'r' } : undefined)) } } as unknown as Repositories;
  const grants = opts.grants ?? ['machines:read', 'projects:read', 'terminals:read'];
  vi.mocked(canAccess).mockImplementation(async (_r, _u, resource, action) => grants.includes(`${resource}:${action}`));
  app.register((a) => mcpRoutes(a, { repos, version: '0.0.0-test', limiter: opts.limiter }));
  return { app, apiTokens };
}

const rpc = (app: ReturnType<typeof Fastify>, body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) },
    payload: body as object,
  });
const call = (name: string, args: object = {}) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.mocked(listMachines).mockResolvedValue({ machines: [{ id: 'm1', name: 'MacBook Pro M4', type: 'agent', os: 'macos', online: true, capabilities: [] }] });
  vi.mocked(readScreen).mockReset();
});

describe('POST /mcp auth', () => {
  it.each([
    ['no header', null],
    ['not bearer', `Basic ${SECRET}`],
    ['malformed token', 'Bearer thb_pat_short'],
    ['unknown token', `Bearer thb_pat_${'B'.repeat(43)}`],
  ])('answers the same 401 for %s', async (_n, auth) => {
    const { app } = build();
    const r = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'Não autenticado', code: 'UNAUTHORIZED' });
  });

  it('401s a token that the repository no longer returns (revoked/expired)', async () => {
    const { app } = build({ token: undefined });
    expect((await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(401);
  });

  it('refuses GET and DELETE with 405', async () => {
    const { app } = build();
    for (const method of ['GET', 'DELETE'] as const) {
      const r = await app.inject({ method, url: '/mcp', headers: { authorization: `Bearer ${SECRET}` } });
      expect(r.statusCode).toBe(405);
      expect(r.headers.allow).toBe('POST');
    }
  });
});

describe('POST /mcp tools', () => {
  it('initializes and lists only the tools the token scopes and user grants allow', async () => {
    const { app, apiTokens } = build();
    const init = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe('termhub');

    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json().result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['find', 'list_machines', 'list_projects', 'list_tabs', 'read_screen', 'wait_for_state']);
    await flush();
    expect(apiTokens.touchLastUsed).toHaveBeenCalledWith('tok1');
  });

  it('shows nothing to a token without the read scope', async () => {
    const { app } = build({ token: token({ scopes: ['tasks'] }) });
    const list = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools).toEqual([]);
  });

  it('calls a tool, returns JSON text, and records one metadata-only audit row', async () => {
    const { app, apiTokens } = build();
    const r = await rpc(app, call('list_machines'));
    const res = r.json().result;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).machines[0].name).toBe('MacBook Pro M4');
    await flush();
    expect(apiTokens.recordEvent).toHaveBeenCalledTimes(1);
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ token_id: 'tok1', tool: 'list_machines', ok: true, error_code: null });
  });

  it('returns expected failures as tool errors with the pt-BR message, and audits the code without content', async () => {
    const { app, apiTokens } = build();
    vi.mocked(readScreen).mockRejectedValue(new ControlError('MACHINE_OFFLINE', 'A máquina está offline'));
    const r = await rpc(app, call('read_screen', { tab_id: 't1' }));
    const res = r.json().result;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('A máquina está offline');
    await flush();
    expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ tool: 'read_screen', tab_id: 't1', ok: false, error_code: 'MACHINE_OFFLINE' });
  });

  it('never leaks unexpected errors or screen text into the audit', async () => {
    const { app, apiTokens } = build();
    vi.mocked(readScreen).mockResolvedValue({ tab_id: 't1', lines: 200, text: 'SECRET-SCREEN' });
    await rpc(app, call('read_screen', { tab_id: 't1' }));
    vi.mocked(readScreen).mockRejectedValue(new Error('pg: connection refused at 10.0.0.1'));
    const r = await rpc(app, call('read_screen', { tab_id: 't1' }));
    expect(r.json().result.content[0].text).toBe('Erro interno ao executar a ferramenta');
    await flush();
    expect(JSON.stringify(apiTokens.recordEvent.mock.calls)).not.toMatch(/SECRET-SCREEN|10\.0\.0\.1/);
  });

  it('refuses a tool outside the token\'s allowed set', async () => {
    const { app } = build({ grants: ['machines:read'] });
    const r = await rpc(app, call('read_screen', { tab_id: 't1' }));
    const body = r.json();
    const text = body.result?.content?.[0]?.text ?? body.error?.message ?? '';
    expect(text).toContain('read_screen');
    expect(readScreen).not.toHaveBeenCalled();
  });

  it('treats an omitted arguments object as empty', async () => {
    const { app } = build();
    const r = await rpc(app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_machines' } });
    expect(r.json().result.isError).toBeFalsy();
    expect(JSON.parse(r.json().result.content[0].text).machines[0].id).toBe('m1');
  });

  it('applies the per-token rate limit', async () => {
    const { app } = build({ limiter: new TokenRateLimiter(1, 60_000) });
    await rpc(app, call('list_machines'));
    const r = await rpc(app, call('list_machines'));
    expect(r.json().result.isError).toBe(true);
    expect(r.json().result.content[0].text).toMatch(/Limite de 1 chamadas por minuto/);
  });
});

describe('POST /mcp over a real socket', () => {
  it('serves initialize and tools/list through the SDK transport on a listening server', async () => {
    const { app } = build();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const post = (body: object) =>
        fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${SECRET}` },
          body: JSON.stringify(body),
        });
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect(init.status).toBe(200);
      expect(init.headers.get('content-type')).toMatch(/application\/json/);
      expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('termhub');
      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(list.status).toBe(200);
      const names = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
      expect(names).toContain('list_machines');
      const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(unauth.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
