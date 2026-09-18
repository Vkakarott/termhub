import { describe, expect, it, vi } from 'vitest';
import { CloudflareAccessClient, CloudflareAccessError } from './access.js';

const cfg = { accountId: 'acc', apiToken: 'tok', appDomain: 'app.termhub.dev', policyName: 'allowlist' };

/** Minimal fake of the Access API: one app, one allowlist policy, PUT replaces it. */
function fakeApi(initialEmails: string[], extraRules: unknown[] = []) {
  let policy: Record<string, unknown> = {
    id: 'pol1',
    name: 'allowlist',
    decision: 'allow',
    precedence: 1,
    include: [...extraRules, ...initialEmails.map((email) => ({ email: { email } }))],
  };
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const json = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, result }), { status });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    // Newest first, like the real API: a path-scoped app on the same host (the agent WebSocket
    // bypass) is listed before the app that owns the allowlist.
    if (url.endsWith('/access/apps') && method === 'GET') return json([{ id: 'ws', domain: 'app.termhub.dev/agent/ws' }, { id: 'other', domain: 'x.example' }, { id: 'app1', domain: 'app.termhub.dev' }]);
    if (url.endsWith('/apps/ws/policies') && method === 'GET') return json([{ id: 'byp', name: 'bypass', decision: 'bypass', include: [{ everyone: {} }] }]);
    if (url.endsWith('/apps/app1/policies') && method === 'GET') return json([{ id: 'deny', name: 'block', decision: 'deny', include: [] }, policy]);
    if (url.endsWith('/apps/app1/policies/pol1') && method === 'PUT') {
      policy = { ...policy, ...body };
      return json(policy);
    }
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `unexpected ${method} ${url}` }] }), { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, emails: () => (policy.include as { email?: { email: string } }[]).map((r) => r.email?.email).filter(Boolean) };
}

describe('CloudflareAccessClient', () => {
  it('prefers the app whose domain matches exactly over path-scoped apps on the same host', async () => {
    const api = fakeApi(['a@x.com']);
    const c = new CloudflareAccessClient(cfg, api.fetchImpl);
    expect(await c.status()).toMatchObject({ policy: 'allowlist', emails: ['a@x.com'] });
    expect(api.calls.some((k) => k.url.endsWith('/apps/ws/policies'))).toBe(false);
  });

  it('reads the allowlist of the app matched by domain', async () => {
    const api = fakeApi(['a@x.com', 'b@x.com']);
    const c = new CloudflareAccessClient(cfg, api.fetchImpl);
    expect(await c.status()).toEqual({ configured: true, domain: 'app.termhub.dev', policy: 'allowlist', emails: ['a@x.com', 'b@x.com'] });
    expect(api.calls.every((k) => k.method === 'GET')).toBe(true);
  });

  it('adds an e-mail keeping the other rules, and is a no-op when already present', async () => {
    const api = fakeApi(['a@x.com'], [{ group: { id: 'g1' } }]);
    const c = new CloudflareAccessClient(cfg, api.fetchImpl);
    await c.add('New@X.com');
    expect(api.emails()).toEqual(['a@x.com', 'new@x.com']);
    const put = api.calls.find((k) => k.method === 'PUT')!;
    expect((put.body as { include: unknown[] }).include[0]).toEqual({ group: { id: 'g1' } });
    expect((put.body as { decision: string }).decision).toBe('allow');
    const puts = api.calls.filter((k) => k.method === 'PUT').length;
    await c.add('a@x.com');
    expect(api.calls.filter((k) => k.method === 'PUT').length).toBe(puts);
  });

  it('removes an e-mail case-insensitively', async () => {
    const api = fakeApi(['a@x.com', 'B@x.com']);
    const c = new CloudflareAccessClient(cfg, api.fetchImpl);
    await c.remove('b@X.com');
    expect(api.emails()).toEqual(['a@x.com']);
  });

  it('serializes concurrent writes so no e-mail is lost', async () => {
    const api = fakeApi([]);
    const c = new CloudflareAccessClient(cfg, api.fetchImpl);
    await Promise.all([c.add('one@x.com'), c.add('two@x.com'), c.add('three@x.com')]);
    expect(api.emails().sort()).toEqual(['one@x.com', 'three@x.com', 'two@x.com']);
  });

  it('caches the app id and surfaces API errors', async () => {
    const api = fakeApi(['a@x.com']);
    const c = new CloudflareAccessClient(cfg, api.fetchImpl);
    await c.status();
    await c.status();
    expect(api.calls.filter((k) => k.url.endsWith('/access/apps')).length).toBe(1);
    const broken = new CloudflareAccessClient({ ...cfg, policyName: 'missing' }, api.fetchImpl);
    await expect(broken.status()).rejects.toBeInstanceOf(CloudflareAccessError);
  });
});
