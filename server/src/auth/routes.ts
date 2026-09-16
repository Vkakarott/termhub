import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { toPublicUser } from '../db/repositories/types.js';
import { HttpError, badRequest, unauthorized } from '../lib/errors.js';
import type { AuthContext } from './middleware.js';
import { buildAuthorizationUrl, exchangeCode, isGoogleEnabled } from './google.js';
import { CSRF_COOKIE, OAUTH_COOKIE, SESSION_COOKIE } from './tokens.js';

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

const sendCodeSchema = z.object({ email: z.string().email().max(254) });
const verifyCodeSchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos'),
});

const callbackSchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(256).optional(),
});

function setSessionCookies(reply: FastifyReply, token: string, csrf: string, expiresAt: Date) {
  const base = { path: '/', sameSite: 'lax' as const, secure: config.auth.cookieSecure, expires: expiresAt };
  reply.setCookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
  // CSRF precisa ser legível pelo JS (double submit).
  reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
}

function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export async function authRoutes(app: FastifyInstance, ctx: AuthContext) {
  const { service } = ctx;

  app.get('/config', { config: { public: true } }, async () => ({
    modes: [...config.auth.modes],
    google: isGoogleEnabled(),
    password: true,
    email_code: true,
  }));

  app.get('/me', { config: { public: true } }, async (request) => {
    if (!request.user) throw unauthorized();
    return { user: toPublicUser(request.user) };
  });

  app.post('/login', { config: { public: true } }, async (request, reply) => {
    if (!config.auth.modes.has('app')) throw badRequest('Login por senha desativado neste modo');
    const body = loginSchema.parse(request.body);
    const result = await service.loginWithPassword(body.email, body.password, request.ip);
    if (!result.ok) {
      if (result.reason === 'locked') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, `Muitas tentativas. Tente novamente em ${Math.ceil(result.retryAfterMs / 1000)}s.`, 'LOCKED');
      }
      throw unauthorized('E-mail ou senha inválidos');
    }
    const { token, csrf, expiresAt } = await service.createSession(result.user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    return { user: toPublicUser(result.user) };
  });

  // --- Login por código enviado por e-mail ---
  app.post('/code/send', { config: { public: true } }, async (request, reply) => {
    if (!config.auth.modes.has('app')) throw badRequest('Login por e-mail desativado neste modo');
    const body = sendCodeSchema.parse(request.body);
    const result = await service.sendLoginCode(body.email, request.ip);
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, 'Muitos envios. Aguarde alguns minutos e tente de novo.', 'RATE_LIMITED');
      }
      throw new HttpError(502, 'Não foi possível enviar o e-mail. Tente novamente.', 'SEND_FAILED');
    }
    return { ok: true, ttl_minutes: Math.round(config.auth.loginCodeTtlMs / 60000) };
  });

  app.post('/code/verify', { config: { public: true } }, async (request, reply) => {
    if (!config.auth.modes.has('app')) throw badRequest('Login por e-mail desativado neste modo');
    const body = verifyCodeSchema.parse(request.body);
    const result = await service.verifyLoginCode(body.email, body.code, request.ip);
    if (!result.ok) {
      if (result.reason === 'locked') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, `Muitas tentativas. Tente novamente em ${Math.ceil(result.retryAfterMs / 1000)}s.`, 'LOCKED');
      }
      throw unauthorized('Código inválido ou expirado');
    }
    const { token, csrf, expiresAt } = await service.createSession(result.user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    return { user: toPublicUser(result.user) };
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await service.destroySession(token);
    clearSessionCookies(reply);
    return { ok: true };
  });

  // --- Google OAuth (Authorization Code + PKCE) ---
  app.get('/google', { config: { public: true } }, async (_request, reply) => {
    if (!isGoogleEnabled() || !config.auth.modes.has('app')) throw badRequest('Google OAuth não configurado');
    const { url, oauth } = buildAuthorizationUrl();
    reply.setCookie(OAUTH_COOKIE, JSON.stringify(oauth), {
      path: '/api/auth/google',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.auth.cookieSecure,
      maxAge: 600,
    });
    return reply.redirect(url, 302);
  });

  app.get('/google/callback', { config: { public: true } }, async (request, reply) => {
    if (!isGoogleEnabled() || !config.auth.modes.has('app')) throw badRequest('Google OAuth não configurado');
    const query = callbackSchema.parse(request.query);
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });

    const fail = (reason: string) => reply.redirect(`/login?error=${encodeURIComponent(reason)}`, 302);
    if (query.error || !query.code || !query.state) return fail('google_denied');

    let saved: { state: string; verifier: string } | null = null;
    try {
      saved = JSON.parse(request.cookies[OAUTH_COOKIE] ?? '');
    } catch {
      saved = null;
    }
    if (!saved || saved.state !== query.state) return fail('state_mismatch');

    let profile;
    try {
      profile = await exchangeCode(query.code, saved.verifier);
    } catch (err) {
      request.log.warn({ err }, 'falha na troca do code do Google');
      return fail('google_exchange');
    }

    const user = await service.loginWithGoogle(profile);
    if (!user) return fail('email_not_allowed');

    const { token, csrf, expiresAt } = await service.createSession(user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    return reply.redirect('/', 302);
  });
}
