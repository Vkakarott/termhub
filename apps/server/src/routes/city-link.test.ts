import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { SHORT_LINK_RETRY_MS, ShortLinkService } from '../public/short-link.js';
import type { CreateLinkOutcome, ShortLinkHttp } from '../public/typetoaccess.js';
import { cityLinkRoutes } from './city-link.js';

const user = (over: Partial<User> = {}): User => ({
  id: 'u1', email: 'p@x.dev', name: 'Pedro', avatar_url: null, nickname: 'pedro', password_hash: null, google_id: null,
  role: 'member', role_id: null, invited_at: null, last_login_at: null, created_at: '2026-09-23T00:00:00.000Z',
  city_short_url_partner: null, city_short_url_custom: null, ...over,
});

function build(opts: { user?: User; http?: ShortLinkHttp | null; now?: () => number } = {}) {
  const me = opts.user ?? user();
  const rows = new Map([[me.id, me]]);
  const users = {
    setCityShortUrlPartner: vi.fn(async (id: string, url: string) => {
      const u = rows.get(id)!;
      if (u.city_short_url_partner) return false;
      rows.set(id, { ...u, city_short_url_partner: url });
      return true;
    }),
    setCityShortUrlCustom: vi.fn(async (id: string, url: string | null) => {
      const u = { ...rows.get(id)!, city_short_url_custom: url };
      rows.set(id, u);
      return u;
    }),
  };
  const log = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
  const shortLinks = new ShortLinkService({ users, http: opts.http === undefined ? httpWith() : opts.http, cityBaseUrl: 'https://termhub.dev/city', log, now: opts.now });
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = me as never;
  });
  app.register((a) => cityLinkRoutes(a, { shortLinks }), { prefix: '/auth' });
  return { app, users, rows };
}

function httpWith(outcomes: CreateLinkOutcome[] = [], location: string | null = null) {
  return { createLink: vi.fn(async () => outcomes.shift() ?? ({ kind: 'failed', status: 500 } as CreateLinkOutcome)), locationOf: vi.fn(async () => location) };
}

describe('GET /auth/me/city-link', () => {
  it('without a key: the feature is off and nothing is called', async () => {
    const { app } = build({ http: null });
    const res = await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, city_url: 'https://termhub.dev/city/@pedro', short_url: null, source: null, partner_url: null });
  });

  it('creates the missing partner link on the way (the lazy retry)', async () => {
    const http = httpWith([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]);
    const { app } = build({ http });
    const res = await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(res.json()).toMatchObject({ enabled: true, short_url: 'https://77a.it/pedro', source: 'partner' });
    expect(http.createLink).toHaveBeenCalledWith({ url: 'https://termhub.dev/city/@pedro', slug: 'pedro' });
  });

  it('retries at most once per 10 minutes when the partner keeps failing', async () => {
    let now = 5_000_000;
    const http = httpWith([]);
    const { app } = build({ http, now: () => now });
    await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(http.createLink).toHaveBeenCalledTimes(1);
    now += SHORT_LINK_RETRY_MS;
    await app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(http.createLink).toHaveBeenCalledTimes(2);
  });

  it('does not call the partner when a custom link is set, nor before a nickname exists', async () => {
    const http = httpWith();
    await build({ http, user: user({ city_short_url_custom: 'https://77a.it/meu' }) }).app.inject({ method: 'GET', url: '/auth/me/city-link' });
    const noNick = await build({ http, user: user({ nickname: null }) }).app.inject({ method: 'GET', url: '/auth/me/city-link' });
    expect(noNick.json()).toMatchObject({ city_url: null, short_url: null });
    expect(http.createLink).not.toHaveBeenCalled();
  });
});

describe('PUT /auth/me/city-link', () => {
  const put = (app: ReturnType<typeof build>['app'], payload: unknown) => app.inject({ method: 'PUT', url: '/auth/me/city-link', payload: payload as object });

  it('stores a custom link that redirects to this city', async () => {
    const { app, rows } = build({ user: user({ city_short_url_partner: 'https://77a.it/pedro' }), http: httpWith([], 'https://termhub.dev/city/@pedro') });
    const res = await put(app, { short_url: 'https://77a.it/meu-link' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ short_url: 'https://77a.it/meu-link', source: 'custom', partner_url: 'https://77a.it/pedro' });
    expect(rows.get('u1')?.city_short_url_custom).toBe('https://77a.it/meu-link');
  });

  // Review Focus 3
  it('refuses a link that points elsewhere, with where it points in the message and the body', async () => {
    const { app, users } = build({ http: httpWith([], 'https://termhub.dev/city/@ana') });
    const res = await put(app, { short_url: 'https://77a.it/meu-link' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'SHORT_LINK_MISMATCH', location: 'https://termhub.dev/city/@ana' });
    expect(res.json().error).toContain('https://termhub.dev/city/@ana');
    expect(res.json().error).toContain('https://termhub.dev/city/@pedro');
    expect(users.setCityShortUrlCustom).not.toHaveBeenCalled();
  });

  it('refuses a link that is not https://77a.it/<slug>, and a body that is not { short_url }', async () => {
    const http = httpWith([], 'https://termhub.dev/city/@pedro');
    const { app } = build({ http });
    expect((await put(app, { short_url: 'https://bit.ly/pedro' })).json().code).toBe('SHORT_LINK_INVALID');
    expect((await put(app, { url: 'https://77a.it/pedro' })).json().code).toBe('VALIDATION');
    expect((await put(app, { short_url: 'x'.repeat(301) })).statusCode).toBe(400);
    expect(http.locationOf).not.toHaveBeenCalled();
  });

  it('answers 502 when the link cannot be opened', async () => {
    const http = { createLink: vi.fn(), locationOf: vi.fn(async () => { throw new TypeError('fetch failed'); }) };
    const res = await put(build({ http }).app, { short_url: 'https://77a.it/meu-link' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('SHORT_LINK_UNREACHABLE');
  });

  it('is off without a key, and needs a nickname', async () => {
    expect((await put(build({ http: null }).app, { short_url: 'https://77a.it/meu' })).statusCode).toBe(404);
    const res = await put(build({ user: user({ nickname: null }) }).app, { short_url: 'https://77a.it/meu' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_REQUIRED');
  });
});

describe('DELETE /auth/me/city-link/custom', () => {
  it('goes back to the partner link', async () => {
    const { app } = build({ user: user({ city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: 'https://77a.it/meu' }) });
    const res = await app.inject({ method: 'DELETE', url: '/auth/me/city-link/custom' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ short_url: 'https://77a.it/pedro', source: 'partner' });
  });

  it('creates the partner link when there is none yet', async () => {
    const http = httpWith([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]);
    const res = await build({ http, user: user({ city_short_url_custom: 'https://77a.it/meu' }) }).app.inject({ method: 'DELETE', url: '/auth/me/city-link/custom' });
    expect(res.json()).toMatchObject({ short_url: 'https://77a.it/pedro', source: 'partner' });
  });

  it('is off without a key', async () => {
    expect((await build({ http: null }).app.inject({ method: 'DELETE', url: '/auth/me/city-link/custom' })).statusCode).toBe(404);
  });
});
