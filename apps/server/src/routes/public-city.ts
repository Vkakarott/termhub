import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { normalizeNickname } from '../public/nickname.js';
import { readPublicCity } from '../public/read.js';

// No length cap here: `normalizeNickname` is the only judge of shape (it is strictly stricter,
// 3-30 characters), so a too-long segment lands on the same 404 as any other bad nickname instead
// of a distinguishable 400.
const params = z.object({ nickname: z.string().min(1) });

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
}
