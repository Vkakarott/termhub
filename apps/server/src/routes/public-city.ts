import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { buildCardSvg, renderCard } from '../public/card.js';
import { normalizeNickname } from '../public/nickname.js';
import { readPublicCity } from '../public/read.js';

// No length cap here: `normalizeNickname` is the only judge of shape (it is strictly stricter,
// 3-30 characters), so a too-long segment lands on the same 404 as any other bad nickname instead
// of a distinguishable 400.
const params = z.object({ nickname: z.string().min(1) });

// building/room are the public (obfuscated) ids from PublicCity, 22 base64url characters; the cap
// is a generous safety limit, not a shape check — an id that matches nothing just renders the
// city-level card (see buildCardSvg's own resolution), the same as an id that was never real.
const cardQuery = z.object({ building: z.string().max(64).optional(), room: z.string().max(64).optional() });

/** Falls back to the landing's own card: a link that shows the product's image beats one that shows a broken one. */
const FALLBACK_CARD = '/og-image.png';

const CARD_CACHE_MS = 5 * 60 * 1000;

/**
 * The rendered card, cached in-process for a few minutes per nickname+depth: a crawler unfurling a
 * link fetches the same card several times in a row, and rasterising is the one real cost on this
 * whole anonymous surface. Never caches a fallback — those are just a redirect, not worth the shelf
 * space, and caching a miss would keep a newly published city's first card looking stale.
 */
const cardCache = new Map<string, { png: Buffer; expiresAt: number }>();

function cachedCard(key: string): Buffer | undefined {
  const hit = cardCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cardCache.delete(key);
    return undefined;
  }
  return hit.png;
}

/**
 * The public city, read by anyone with the link. No session, no Access: this lives on the landing
 * host. A nickname that does not exist and one that published nothing answer the same 404 — an empty
 * city would tell a stranger which nicknames are taken.
 */
export async function publicCityRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/city/:nickname', { config: { public: true } }, async (request, reply) => {
    const parsed = normalizeNickname(params.parse(request.params).nickname);
    if (!parsed.ok) return reply.code(404).send({ error: 'Cidade não encontrada', code: 'NOT_FOUND' });
    const city = await readPublicCity(repos, parsed.value);
    if (!city) return reply.code(404).send({ error: 'Cidade não encontrada', code: 'NOT_FOUND' });
    request.log.debug({ nickname: parsed.value, buildings: city.buildings.length }, 'public city: snapshot');
    reply.header('cache-control', 'public, max-age=5');
    return city;
  });

  /**
   * The link preview card (Open Graph / Twitter image): what a pasted `/city/@<nickname>` link
   * shows before anyone clicks. A nickname that does not exist, a city with nothing published, and
   * a server that cannot rasterise all fall back to the same PNG the landing already serves.
   */
  app.get('/city/:nickname/card.png', { config: { public: true } }, async (request, reply) => {
    const parsed = normalizeNickname(params.parse(request.params).nickname);
    if (!parsed.ok) return reply.redirect(FALLBACK_CARD, 302);
    const { building, room } = cardQuery.parse(request.query);
    const cacheKey = `${parsed.value}:${building ?? ''}:${room ?? ''}`;
    const cached = cachedCard(cacheKey);
    if (cached) {
      reply.header('content-type', 'image/png');
      reply.header('cache-control', 'public, max-age=300');
      return cached;
    }
    const city = await readPublicCity(repos, parsed.value);
    if (!city) return reply.redirect(FALLBACK_CARD, 302);
    const png = await renderCard(buildCardSvg(city, { building, room }));
    if (!png) return reply.redirect(FALLBACK_CARD, 302);
    cardCache.set(cacheKey, { png, expiresAt: Date.now() + CARD_CACHE_MS });
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'public, max-age=300');
    return png;
  });
}
