import { z } from 'zod';
import { normalizeCustomShortUrl } from './short-link.js';

/**
 * TypeToAccess, the partner that shortens public-city links (77a.it/<slug>). This module is the only
 * code that talks to it or to 77a.it, so every test stubs it and none ever reaches the real API.
 * The key is a server secret: it never leaves this process and is never logged.
 */
export const TYPETOACCESS_LINKS_URL = 'https://api.typetoaccess.it/v1/links';
export const SHORT_LINK_TIMEOUT_MS = 5_000;

// Only the field this code uses is required; the API also answers id, slug, url, clickCount, createdAt.
const createdSchema = z.object({ shortUrl: z.string().url() });

export type CreateLinkOutcome = { kind: 'created'; shortUrl: string } | { kind: 'slug_taken' } | { kind: 'failed'; status: number | null };

export interface ShortLinkHttp {
  /** POST /v1/links. Never throws: a network error or a timeout is { kind: 'failed', status: null }. */
  createLink(input: { url: string; slug?: string }): Promise<CreateLinkOutcome>;
  /** One GET of `url` with redirects NOT followed: the absolute Location it answers, or null when it is not a redirect. Throws on a network error or a timeout. */
  locationOf(url: string): Promise<string | null>;
}

export function createTypeToAccessClient(opts: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): ShortLinkHttp {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SHORT_LINK_TIMEOUT_MS;
  return {
    async createLink({ url, slug }) {
      let res: Response;
      try {
        res = await doFetch(TYPETOACCESS_LINKS_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(slug ? { url, slug } : { url }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: 'failed', status: null };
      }
      if (res.status === 409) {
        await res.body?.cancel().catch(() => {});
        return { kind: 'slug_taken' };
      }
      if (res.status !== 201 && res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return { kind: 'failed', status: res.status };
      }
      const parsed = createdSchema.safeParse(await res.json().catch(() => null));
      // only a https://77a.it/<slug> link is printed on a city; anything else stores nothing
      const shortUrl = parsed.success ? normalizeCustomShortUrl(parsed.data.shortUrl) : null;
      return shortUrl ? { kind: 'created', shortUrl } : { kind: 'failed', status: res.status };
    },

    async locationOf(url) {
      // HEAD, so checking a link does not count as a click on it; GET only for a server that refuses HEAD
      let res = await doFetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => {});
      if (res.status === 405 || res.status === 501) {
        res = await doFetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        await res.body?.cancel().catch(() => {});
      }
      if (res.status < 300 || res.status >= 400) return null;
      const location = res.headers.get('location');
      if (!location) return null;
      try {
        // absolute, with the host lower-cased by the URL parser
        return new URL(location, url).toString();
      } catch {
        return null;
      }
    },
  };
}
