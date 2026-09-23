import { describe, expect, it, vi } from 'vitest';
import { createTypeToAccessClient, TYPETOACCESS_LINKS_URL } from './typetoaccess.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CREATED = { id: 'l1', slug: 'pedro', url: 'https://termhub.dev/city/@pedro', shortUrl: 'https://77a.it/pedro', clickCount: 0, createdAt: '2026-09-23T10:00:00.000Z' };

describe('createTypeToAccessClient', () => {
  it('creates a link with the bearer key, the city url and the slug', async () => {
    const fetchImpl = vi.fn(async () => json(201, CREATED));
    const client = createTypeToAccessClient({ apiKey: 'k-secret', fetchImpl });
    expect(await client.createLink({ url: 'https://termhub.dev/city/@pedro', slug: 'pedro' })).toEqual({ kind: 'created', shortUrl: 'https://77a.it/pedro' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TYPETOACCESS_LINKS_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k-secret');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://termhub.dev/city/@pedro', slug: 'pedro' });
  });

  it('sends no slug at all when none is asked for (a random one)', async () => {
    const fetchImpl = vi.fn(async () => json(201, { ...CREATED, slug: 'x9k2', shortUrl: 'https://77a.it/x9k2' }));
    const client = createTypeToAccessClient({ apiKey: 'k', fetchImpl });
    expect(await client.createLink({ url: 'https://termhub.dev/city/@pedro' })).toEqual({ kind: 'created', shortUrl: 'https://77a.it/x9k2' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://termhub.dev/city/@pedro' });
  });

  it('tells a taken slug apart from every other failure', async () => {
    const client = (res: Response | Error) => createTypeToAccessClient({ apiKey: 'k', fetchImpl: vi.fn(async () => { if (res instanceof Error) throw res; return res; }) });
    expect(await client(json(409, { error: 'taken' })).createLink({ url: 'u', slug: 'pedro' })).toEqual({ kind: 'slug_taken' });
    expect(await client(json(429, {})).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 429 });
    expect(await client(json(500, {})).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 500 });
    expect(await client(json(402, { error: 'quota' })).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 402 });
    expect(await client(new TypeError('fetch failed')).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: null });
    // a 201 whose body is not what the API documents is not a link
    expect(await client(json(201, { nope: true })).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 201 });
    // a created link that is not https://77a.it/<slug> is not one to print on a city
    expect(await client(json(201, { ...CREATED, shortUrl: 'https://evil.example/pedro' })).createLink({ url: 'u' })).toEqual({ kind: 'failed', status: 201 });
  });

  it('gives up after the timeout instead of holding the caller', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const client = createTypeToAccessClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 });
    expect(await client.createLink({ url: 'u' })).toEqual({ kind: 'failed', status: null });
  });

  it('reads where a short link points without following it', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://TERMHUB.dev/city/@pedro/' } }));
    const client = createTypeToAccessClient({ apiKey: 'k', fetchImpl });
    expect(await client.locationOf('https://77a.it/pedro')).toBe('https://termhub.dev/city/@pedro/');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://77a.it/pedro');
    expect(init.redirect).toBe('manual');
    // HEAD, so checking a pasted link does not count as a click on it
    expect(init.method).toBe('HEAD');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to GET only when HEAD is not allowed', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'HEAD' ? new Response(null, { status: 405 }) : new Response(null, { status: 302, headers: { location: 'https://termhub.dev/city/@pedro' } }),
    );
    const client = createTypeToAccessClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.locationOf('https://77a.it/pedro')).toBe('https://termhub.dev/city/@pedro');
    expect(fetchImpl.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(['HEAD', 'GET']);
    expect((fetchImpl.mock.calls[1][1] as RequestInit).redirect).toBe('manual');
  });

  it('answers null for a link that does not redirect, and throws when it cannot be reached', async () => {
    const ok = createTypeToAccessClient({ apiKey: 'k', fetchImpl: vi.fn(async () => new Response('page', { status: 200 })) });
    expect(await ok.locationOf('https://77a.it/nada')).toBeNull();
    const noLocation = createTypeToAccessClient({ apiKey: 'k', fetchImpl: vi.fn(async () => new Response(null, { status: 302 })) });
    expect(await noLocation.locationOf('https://77a.it/nada')).toBeNull();
    const down = createTypeToAccessClient({ apiKey: 'k', fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    await expect(down.locationOf('https://77a.it/nada')).rejects.toThrow();
  });
});
