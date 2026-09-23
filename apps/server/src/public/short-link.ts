import type { FastifyBaseLogger } from 'fastify';
import type { User } from '../db/repositories/types.js';
import type { UsersRepository } from '../db/repositories/users.js';
import type { ShortLinkHttp } from './typetoaccess.js';

/**
 * The public city's short link (spec 2026-09-23 §3). termhub creates one through TypeToAccess when
 * a nickname is claimed (the "partner" link, nickname as slug, random on a clash), and the person may
 * paste a link of their own to replace it. The effective one is custom ?? partner. The nickname is
 * locked once set, so the city URL — and so every link to it — never goes stale.
 */

/** One attempt per user per this long: the lazy retry must not turn every visit to "Minha cidade" into an API call. */
export const SHORT_LINK_RETRY_MS = 10 * 60 * 1000;

const CUSTOM = /^https:\/\/77a\.it\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/i;

/** A pasted custom link as `https://77a.it/<slug>`, or null when it is not one. The slug keeps its case. */
export function normalizeCustomShortUrl(input: string): string | null {
  const m = CUSTOM.exec(input.trim());
  return m ? `https://77a.it/${m[1]}` : null;
}

/** Whether a redirect's Location is this city's URL: a trailing slash and the host's case are tolerated, nothing else. */
export function sameCityUrl(location: string, expected: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(location);
    b = new URL(expected);
  } catch {
    return false;
  }
  const path = (u: URL) => {
    const p = u.pathname.replace(/\/+$/, '');
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  };
  return a.protocol === b.protocol && a.host === b.host && path(a) === path(b) && a.search === '' && a.hash === '' && a.username === '' && a.password === '';
}

export function effectiveShortUrl(u: Pick<User, 'city_short_url_partner' | 'city_short_url_custom'>): string | null {
  return u.city_short_url_custom ?? u.city_short_url_partner ?? null;
}

/** What GET/PUT/DELETE /me/city-link answer. */
export interface CityLinkView {
  /** TYPETOACCESS_API_KEY is set: partner links are created and a custom one can be set */
  enabled: boolean;
  /** the long address, null until the person has a nickname */
  city_url: string | null;
  /** the link to hand out; null = use city_url */
  short_url: string | null;
  source: 'custom' | 'partner' | null;
  partner_url: string | null;
}

export type SetCustomOutcome =
  | { ok: true; user: User }
  | { ok: false; code: 'SHORT_LINK_INVALID' }
  | { ok: false; code: 'SHORT_LINK_MISMATCH'; location: string | null }
  | { ok: false; code: 'SHORT_LINK_UNREACHABLE' };

type UsersPort = Pick<UsersRepository, 'setCityShortUrlPartner' | 'setCityShortUrlCustom'>;

export class ShortLinkService {
  /** user id -> when the last partner attempt started (in memory: a restart may try once more, which is fine) */
  private readonly attempts = new Map<string, number>();
  /** user id -> the attempt in flight, shared by every caller that arrives while it runs */
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly now: () => number;

  constructor(private readonly deps: { users: UsersPort; http: ShortLinkHttp | null; cityBaseUrl: string; log: FastifyBaseLogger; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  /** Without a key the whole feature is off: no calls, no editing, the long link everywhere. */
  get enabled(): boolean {
    return this.deps.http !== null;
  }

  cityUrlOf(nickname: string): string {
    return `${this.deps.cityBaseUrl}/@${encodeURIComponent(nickname)}`;
  }

  view(user: User): CityLinkView {
    const custom = user.city_short_url_custom;
    const partner = user.city_short_url_partner;
    return {
      enabled: this.enabled,
      city_url: user.nickname ? this.cityUrlOf(user.nickname) : null,
      short_url: custom ?? partner ?? null,
      source: custom ? 'custom' : partner ? 'partner' : null,
      partner_url: partner,
    };
  }

  /** Right after a first nickname claim: starts the partner link and returns at once (the route never waits for it). */
  onNicknameClaimed(user: User): void {
    void this.ensurePartner(user);
  }

  /**
   * The partner link: the stored one, or one attempt to create it — at most one per user every
   * SHORT_LINK_RETRY_MS, and one at a time (concurrent callers share it). Never throws; null when
   * there is none (yet).
   */
  ensurePartner(user: User): Promise<string | null> {
    const http = this.deps.http;
    if (!http || !user.nickname) return Promise.resolve(null);
    if (user.city_short_url_partner) return Promise.resolve(user.city_short_url_partner);
    const running = this.inflight.get(user.id);
    if (running) return running;
    const now = this.now();
    for (const [id, at] of this.attempts) if (now - at >= SHORT_LINK_RETRY_MS) this.attempts.delete(id);
    if (this.attempts.has(user.id)) return Promise.resolve(null);
    this.attempts.set(user.id, now);
    const attempt = this.createPartner(http, user.id, user.nickname).finally(() => this.inflight.delete(user.id));
    this.inflight.set(user.id, attempt);
    return attempt;
  }

  private async createPartner(http: ShortLinkHttp, userId: string, nickname: string): Promise<string | null> {
    const url = this.cityUrlOf(nickname);
    let slug: 'nickname' | 'random' = 'nickname';
    try {
      let out = await http.createLink({ url, slug: nickname });
      if (out.kind === 'slug_taken') {
        slug = 'random';
        out = await http.createLink({ url });
      }
      if (out.kind !== 'created') {
        this.deps.log.warn({ userId, slug, status: out.kind === 'failed' ? out.status : 409 }, 'short link: partner link not created');
        return null;
      }
      const stored = await this.deps.users.setCityShortUrlPartner(userId, out.shortUrl);
      this.deps.log.info({ userId, slug, stored }, 'short link: partner link created');
      return stored ? out.shortUrl : null;
    } catch (err) {
      this.deps.log.warn({ userId, slug, err: err instanceof Error ? err.message : String(err) }, 'short link: partner link not created');
      return null;
    }
  }

  /** A pasted link replaces the partner one only when it redirects (not followed) to this person's city. */
  async setCustom(user: User, input: string): Promise<SetCustomOutcome> {
    const http = this.deps.http;
    const shortUrl = normalizeCustomShortUrl(input);
    if (!http || !user.nickname || !shortUrl) return { ok: false, code: 'SHORT_LINK_INVALID' };
    let location: string | null;
    try {
      location = await http.locationOf(shortUrl);
    } catch (err) {
      this.deps.log.warn({ userId: user.id, err: err instanceof Error ? err.message : String(err) }, 'short link: custom link unreachable');
      return { ok: false, code: 'SHORT_LINK_UNREACHABLE' };
    }
    if (!location || !sameCityUrl(location, this.cityUrlOf(user.nickname))) {
      this.deps.log.info({ userId: user.id, redirects: location !== null }, 'short link: custom link refused');
      return { ok: false, code: 'SHORT_LINK_MISMATCH', location };
    }
    return { ok: true, user: await this.deps.users.setCityShortUrlCustom(user.id, shortUrl) };
  }

  /** Back to the partner link; when there is none yet, one is created as on a first claim. */
  async clearCustom(user: User): Promise<User> {
    const updated = await this.deps.users.setCityShortUrlCustom(user.id, null);
    if (updated.city_short_url_partner) return updated;
    const partner = await this.ensurePartner(updated);
    return partner ? { ...updated, city_short_url_partner: partner } : updated;
  }
}
