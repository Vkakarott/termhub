import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '../db/repositories/types.js';
import { effectiveShortUrl, normalizeCustomShortUrl, sameCityUrl, SHORT_LINK_RETRY_MS, ShortLinkService } from './short-link.js';
import type { CreateLinkOutcome, ShortLinkHttp } from './typetoaccess.js';

const BASE = 'https://termhub.dev/city';

const user = (over: Partial<User> = {}): User => ({
  id: 'u1', email: 'p@x.dev', name: 'Pedro', avatar_url: null, nickname: 'pedro', password_hash: null, google_id: null,
  role: 'member', role_id: null, invited_at: null, last_login_at: null, created_at: '2026-09-23T00:00:00.000Z',
  city_short_url_partner: null, city_short_url_custom: null, ...over,
});

/** The users repository as the service sees it, over an in-memory row per user. */
function fakeUsers(...seed: User[]) {
  const rows = new Map(seed.map((u) => [u.id, u]));
  return {
    rows,
    findById: vi.fn(async (id: string) => rows.get(id)),
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
}

/** TypeToAccess as the service sees it: createLink answers the queued outcomes in order. */
function fakeHttp(outcomes: CreateLinkOutcome[] = [], location: string | null | Error = null) {
  return {
    createLink: vi.fn(async (_input: { url: string; slug?: string }) => outcomes.shift() ?? ({ kind: 'failed', status: 500 } as CreateLinkOutcome)),
    locationOf: vi.fn(async (_url: string) => {
      if (location instanceof Error) throw location;
      return location;
    }),
  } satisfies ShortLinkHttp;
}

const log = () => ({ info: vi.fn(), warn: vi.fn() }) as unknown as FastifyBaseLogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function service(opts: { http?: ReturnType<typeof fakeHttp> | null; users?: ReturnType<typeof fakeUsers>; now?: () => number } = {}) {
  const users = opts.users ?? fakeUsers(user());
  const http = opts.http === undefined ? fakeHttp() : opts.http;
  const logger = log();
  const s = new ShortLinkService({ users, http, cityBaseUrl: BASE, log: logger, now: opts.now });
  return { s, users, http, logger };
}

describe('the partner link', () => {
  it('is created with the nickname as the slug and stored', async () => {
    const { s, users, http } = service({ http: fakeHttp([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]) });
    expect(await s.ensurePartner(user())).toBe('https://77a.it/pedro');
    expect(http!.createLink).toHaveBeenCalledWith({ url: 'https://termhub.dev/city/@pedro', slug: 'pedro' });
    expect(users.rows.get('u1')?.city_short_url_partner).toBe('https://77a.it/pedro');
  });

  it('falls back to a random slug once when the nickname is taken', async () => {
    const { s, users, http } = service({ http: fakeHttp([{ kind: 'slug_taken' }, { kind: 'created', shortUrl: 'https://77a.it/x9k2' }]) });
    expect(await s.ensurePartner(user())).toBe('https://77a.it/x9k2');
    expect(http!.createLink).toHaveBeenCalledTimes(2);
    expect(http!.createLink.mock.calls[1][0]).toEqual({ url: 'https://termhub.dev/city/@pedro' });
    expect(users.rows.get('u1')?.city_short_url_partner).toBe('https://77a.it/x9k2');
  });

  // Review fix 3: a 409 on the nickname may be this city's own link from an earlier attempt whose
  // answer was lost (a timeout after the partner created it). Reuse it rather than spend a second
  // link on a random slug.
  it('reuses the nickname link when the taken slug already points to this city', async () => {
    const { s, users, http } = service({ http: fakeHttp([{ kind: 'slug_taken' }], 'https://termhub.dev/city/@pedro/') });
    expect(await s.ensurePartner(user())).toBe('https://77a.it/pedro');
    expect(http!.locationOf).toHaveBeenCalledWith('https://77a.it/pedro');
    expect(http!.createLink).toHaveBeenCalledTimes(1);
    expect(users.rows.get('u1')?.city_short_url_partner).toBe('https://77a.it/pedro');
  });

  it('creates a random link when the taken slug points elsewhere', async () => {
    const { s, http } = service({ http: fakeHttp([{ kind: 'slug_taken' }, { kind: 'created', shortUrl: 'https://77a.it/x9k2' }], 'https://termhub.dev/city/@ana') });
    expect(await s.ensurePartner(user())).toBe('https://77a.it/x9k2');
    expect(http!.createLink).toHaveBeenCalledTimes(2);
  });

  // Review fix 6: an attempt that finished between the caller loading its user and asking here
  // stored a link; the rate-limit short-circuit reads it back instead of answering null.
  it('answers the stored link when a recent attempt already created it', async () => {
    const { s, users } = service({ http: fakeHttp([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]) });
    const stale = user();
    expect(await s.ensurePartner(stale)).toBe('https://77a.it/pedro');
    expect(await s.ensurePartner(stale)).toBe('https://77a.it/pedro');
    expect(users.findById).toHaveBeenCalledWith('u1');
  });

  it('stores nothing when the partner fails, and logs metadata only', async () => {
    for (const outcome of [{ kind: 'failed', status: 500 }, { kind: 'failed', status: 429 }, { kind: 'failed', status: null }] as CreateLinkOutcome[]) {
      const { s, users, logger } = service({ http: fakeHttp([outcome]) });
      expect(await s.ensurePartner(user())).toBeNull();
      expect(users.setCityShortUrlPartner).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Bearer');
    }
    // a random slug that is taken too is a failure, not a loop
    const { s, http } = service({ http: fakeHttp([{ kind: 'slug_taken' }, { kind: 'slug_taken' }]) });
    expect(await s.ensurePartner(user())).toBeNull();
    expect(http!.createLink).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a key, without a nickname, or when a partner link already exists', async () => {
    const off = service({ http: null });
    expect(off.s.enabled).toBe(false);
    expect(await off.s.ensurePartner(user())).toBeNull();
    const on = service();
    expect(await on.s.ensurePartner(user({ nickname: null }))).toBeNull();
    expect(await on.s.ensurePartner(user({ city_short_url_partner: 'https://77a.it/pedro' }))).toBe('https://77a.it/pedro');
    expect(on.http!.createLink).not.toHaveBeenCalled();
  });

  it('tries at most once per user every 10 minutes', async () => {
    let now = 1_000_000;
    const { s, http } = service({ http: fakeHttp([]), now: () => now });
    expect(await s.ensurePartner(user())).toBeNull();
    expect(await s.ensurePartner(user())).toBeNull();
    expect(http!.createLink).toHaveBeenCalledTimes(1);
    now += SHORT_LINK_RETRY_MS - 1;
    expect(await s.ensurePartner(user())).toBeNull();
    expect(http!.createLink).toHaveBeenCalledTimes(1);
    now += 1;
    await s.ensurePartner(user());
    expect(http!.createLink).toHaveBeenCalledTimes(2);
    // another person is not held back by this one's attempts
    const users = fakeUsers(user(), user({ id: 'u2', nickname: 'ana' }));
    const two = service({ http: fakeHttp([]), users, now: () => now });
    await two.s.ensurePartner(user());
    await two.s.ensurePartner(user({ id: 'u2', nickname: 'ana' }));
    expect(two.http!.createLink).toHaveBeenCalledTimes(2);
  });

  // Review Focus 2: the claim's background attempt and an immediate GET /me/city-link must not
  // create two links (each costs quota, and the second would get a random slug).
  it('shares one attempt between concurrent callers', async () => {
    let finish!: (o: CreateLinkOutcome) => void;
    const http = fakeHttp();
    http.createLink.mockImplementationOnce(() => new Promise<CreateLinkOutcome>((resolve) => (finish = resolve)));
    const { s } = service({ http });
    const a = s.ensurePartner(user());
    const b = s.ensurePartner(user());
    finish({ kind: 'created', shortUrl: 'https://77a.it/pedro' });
    expect(await a).toBe('https://77a.it/pedro');
    expect(await b).toBe('https://77a.it/pedro');
    expect(http.createLink).toHaveBeenCalledTimes(1);
  });

  // Review Focus 1: the nickname route must not wait for the partner.
  it('onNicknameClaimed returns at once, while the partner is still answering', async () => {
    const http = fakeHttp();
    http.createLink.mockImplementationOnce(() => new Promise<CreateLinkOutcome>(() => {}));
    const { s } = service({ http });
    const t0 = Date.now();
    expect(s.onNicknameClaimed(user())).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(50);
    expect(http.createLink).toHaveBeenCalledTimes(1);
  });
});

describe('the custom link', () => {
  it('accepts only https://77a.it/<slug>, canonicalised', () => {
    expect(normalizeCustomShortUrl('https://77a.it/meu-link')).toBe('https://77a.it/meu-link');
    expect(normalizeCustomShortUrl('  HTTPS://77A.IT/Meu_Link/  ')).toBe('https://77a.it/Meu_Link');
    for (const bad of ['', '77a.it/pedro', 'http://77a.it/pedro', 'https://77a.it/', 'https://evil.it/pedro', 'https://77a.it.evil.com/pedro', 'https://77a.it/a/b', 'https://77a.it/pedro?x=1', 'https://user@77a.it/pedro', `https://77a.it/${'a'.repeat(65)}`]) {
      expect(normalizeCustomShortUrl(bad)).toBeNull();
    }
  });

  // Review Focus 3
  it('matches the city url tolerating a trailing slash and the case of the host, nothing else', () => {
    const city = 'https://termhub.dev/city/@pedro';
    expect(sameCityUrl('https://termhub.dev/city/@pedro', city)).toBe(true);
    expect(sameCityUrl('https://termhub.dev/city/@pedro/', city)).toBe(true);
    expect(sameCityUrl('https://TermHub.DEV/city/@pedro', city)).toBe(true);
    for (const other of ['https://termhub.dev/city/@ana', 'http://termhub.dev/city/@pedro', 'https://termhub.dev/city/@pedro?utm=x', 'https://termhub.dev/city/@pedro#top', 'https://termhub.dev/city/@pedro/b1', 'https://evil.dev/city/@pedro', 'not a url']) {
      expect(sameCityUrl(other, city)).toBe(false);
    }
  });

  it('is stored only when it redirects to this person’s city', async () => {
    const { s, users, http } = service({ http: fakeHttp([], 'https://termhub.dev/city/@pedro/') });
    const out = await s.setCustom(user(), 'https://77a.it/meu-link');
    expect(out).toMatchObject({ ok: true, user: { city_short_url_custom: 'https://77a.it/meu-link' } });
    expect(http!.locationOf).toHaveBeenCalledWith('https://77a.it/meu-link');
    expect(users.rows.get('u1')?.city_short_url_custom).toBe('https://77a.it/meu-link');
  });

  it('is refused, saying where it points, when it goes elsewhere or nowhere', async () => {
    const elsewhere = service({ http: fakeHttp([], 'https://termhub.dev/city/@ana') });
    expect(await elsewhere.s.setCustom(user(), 'https://77a.it/meu-link')).toEqual({ ok: false, code: 'SHORT_LINK_MISMATCH', location: 'https://termhub.dev/city/@ana' });
    expect(elsewhere.users.setCityShortUrlCustom).not.toHaveBeenCalled();
    const nowhere = service({ http: fakeHttp([], null) });
    expect(await nowhere.s.setCustom(user(), 'https://77a.it/meu-link')).toEqual({ ok: false, code: 'SHORT_LINK_MISMATCH', location: null });
    const down = service({ http: fakeHttp([], new TypeError('fetch failed')) });
    expect(await down.s.setCustom(user(), 'https://77a.it/meu-link')).toEqual({ ok: false, code: 'SHORT_LINK_UNREACHABLE' });
  });

  it('never requests a link that is not a 77a.it link', async () => {
    const { s, http } = service({ http: fakeHttp([], 'https://termhub.dev/city/@pedro') });
    expect(await s.setCustom(user(), 'https://evil.it/pedro')).toEqual({ ok: false, code: 'SHORT_LINK_INVALID' });
    expect(http!.locationOf).not.toHaveBeenCalled();
  });

  it('clearing it makes the partner link effective again, creating one if there is none', async () => {
    const withPartner = user({ city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: 'https://77a.it/meu' });
    const a = service({ users: fakeUsers(withPartner) });
    const cleared = await a.s.clearCustom(withPartner);
    expect(cleared.ok).toBe(true);
    expect(cleared.ok && effectiveShortUrl(cleared.user)).toBe('https://77a.it/pedro');
    expect(a.http!.createLink).not.toHaveBeenCalled();

    const noPartner = user({ city_short_url_custom: 'https://77a.it/meu' });
    const b = service({ users: fakeUsers(noPartner), http: fakeHttp([{ kind: 'created', shortUrl: 'https://77a.it/pedro' }]) });
    const restored = await b.s.clearCustom(noPartner);
    expect(restored.ok && effectiveShortUrl(restored.user)).toBe('https://77a.it/pedro');
    expect(b.users.rows.get('u1')?.city_short_url_custom).toBeNull();
  });

  // Review fix 1: the custom link may be the only working one; it is cleared only once a partner
  // link exists to take its place.
  it('keeps the custom link when no partner link can be had', async () => {
    const noPartner = user({ city_short_url_custom: 'https://77a.it/meu' });
    const c = service({ users: fakeUsers(noPartner), http: fakeHttp([{ kind: 'failed', status: 500 }]) });
    expect(await c.s.clearCustom(noPartner)).toEqual({ ok: false, code: 'SHORT_LINK_PARTNER_UNAVAILABLE' });
    expect(c.users.setCityShortUrlCustom).not.toHaveBeenCalled();
    expect(c.users.rows.get('u1')?.city_short_url_custom).toBe('https://77a.it/meu');
  });
});

describe('the view', () => {
  it('says which link is effective and where it came from', () => {
    const { s } = service();
    expect(s.view(user())).toEqual({ enabled: true, city_url: 'https://termhub.dev/city/@pedro', short_url: null, source: null, partner_url: null });
    expect(s.view(user({ city_short_url_partner: 'https://77a.it/pedro' }))).toMatchObject({ short_url: 'https://77a.it/pedro', source: 'partner' });
    expect(s.view(user({ city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: 'https://77a.it/meu' }))).toMatchObject({ short_url: 'https://77a.it/meu', source: 'custom', partner_url: 'https://77a.it/pedro' });
    expect(s.view(user({ nickname: null })).city_url).toBeNull();
    expect(service({ http: null }).s.view(user()).enabled).toBe(false);
  });
});
