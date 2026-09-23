import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unauthorized } from '../lib/errors.js';
import { effectiveShortUrl, type ShortLinkService } from '../public/short-link.js';

const customBody = z.object({ short_url: z.string().trim().min(1).max(300) });

/**
 * The signed-in person's city short link (Settings → Minha cidade). Authenticated, no resource
 * grant, like /me/nickname: every account has a city. Registered under /auth beside authRoutes.
 */
export async function cityLinkRoutes(app: FastifyInstance, deps: { shortLinks: ShortLinkService }) {
  const links = deps.shortLinks;

  app.get('/me/city-link', async (request) => {
    if (!request.user) throw unauthorized();
    let user = request.user;
    // the lazy retry (spec §3.3): a claimed nickname, the key set and no short link yet — one
    // attempt, rate-limited per user inside the service, and shared with a claim still running
    if (links.enabled && user.nickname && !effectiveShortUrl(user)) {
      const partner = await links.ensurePartner(user);
      if (partner) user = { ...user, city_short_url_partner: partner };
    }
    return links.view(user);
  });

  app.put('/me/city-link', async (request, reply) => {
    if (!request.user) throw unauthorized();
    if (!links.enabled) return reply.code(404).send({ error: 'O link curto não está disponível nesta instância', code: 'SHORT_LINK_DISABLED' });
    const nickname = request.user.nickname;
    if (!nickname) return reply.code(409).send({ error: 'Escolha seu apelido antes', code: 'NICKNAME_REQUIRED' });
    const { short_url } = customBody.parse(request.body);
    const out = await links.setCustom(request.user, short_url);
    if (out.ok) {
      request.log.info({ userId: request.user.id }, 'short link: custom link set');
      return links.view(out.user);
    }
    if (out.code === 'SHORT_LINK_INVALID') return reply.code(400).send({ error: 'Use um link no formato https://77a.it/seu-link', code: out.code });
    if (out.code === 'SHORT_LINK_UNREACHABLE') return reply.code(502).send({ error: 'Não foi possível abrir esse link agora. Tente de novo.', code: out.code });
    const cityUrl = links.cityUrlOf(nickname);
    const error = out.location
      ? `Esse link leva para ${out.location}, não para a sua cidade (${cityUrl}).`
      : `Esse link não leva para a sua cidade (${cityUrl}).`;
    return reply.code(400).send({ error, code: out.code, location: out.location });
  });

  app.delete('/me/city-link/custom', async (request, reply) => {
    if (!request.user) throw unauthorized();
    if (!links.enabled) return reply.code(404).send({ error: 'O link curto não está disponível nesta instância', code: 'SHORT_LINK_DISABLED' });
    const user = await links.clearCustom(request.user);
    request.log.info({ userId: request.user.id }, 'short link: custom link cleared');
    return links.view(user);
  });
}
