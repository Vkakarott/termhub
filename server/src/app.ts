import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { config, ROOT_DIR } from './config.js';
import { getPrisma, closePrisma } from './db/prisma.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import { createMailer } from './email/mailer.js';
import { AuthService, authRoutes, buildAuthHook, type AuthContext } from './auth/index.js';
import { HttpError } from './lib/errors.js';
import { machineRoutes } from './routes/machines.js';
import { projectRoutes } from './routes/projects.js';
import { tabRoutes } from './routes/tabs.js';
import { systemRoutes } from './routes/system.js';
import { projectTaskRoutes, taskRoutes } from './routes/tasks.js';
import { noteRoutes } from './routes/notes.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { integrationRoutes } from './routes/integrations.js';
import { setupRoutes } from './routes/setup.js';
import { projectTicketRoutes, taskTicketRoutes } from './routes/tickets.js';
import { aiAccountRoutes } from './routes/ai-accounts.js';
import { startTicketSyncScheduler } from './setup/tickets-sync.js';
import { attachTerminalWebSocket } from './terminal/ws.js';
import { seed } from './seed.js';


export interface App {
  fastify: FastifyInstance;
  repos: Repositories;
  auth: AuthContext;
}

export async function buildApp(): Promise<App> {
  const fastify = Fastify({
    logger: {
      level: config.isProd ? 'info' : 'debug',
      transport: config.isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
      // Nunca logar cookies/authorization.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["cf-access-jwt-assertion"]'],
    },
    trustProxy: true, // atrás do Cloudflare Tunnel / cloudflared em 127.0.0.1
    bodyLimit: 1024 * 1024,
  });

  const prisma = getPrisma();
  await prisma.$connect();
  const repos = createRepositories(prisma);
  await seed(repos, (m) => fastify.log.info(m));

  const mailer = createMailer((m) => fastify.log.info(m));
  const authService = new AuthService(repos, mailer);
  const auth: AuthContext = { service: authService, repos };

  await fastify.register(fastifyCookie);

  // JSON tolerante a body vazio (POST sem corpo vira {}).
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(Object.assign(err as Error, { statusCode: 400 }), undefined);
    }
  });

  // Cabeçalhos básicos de segurança
  fastify.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
  });

  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Dados inválidos', code: 'VALIDATION', issues: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, 'erro não tratado');
    return reply.code(status).send({ error: status >= 500 ? 'Erro interno' : e.message, code: 'ERROR' });
  });

  // --- API (tudo autenticado, exceto rotas marcadas como public) ---
  await fastify.register(
    async (api) => {
      api.addHook('preHandler', buildAuthHook(auth));
      await api.register((a) => authRoutes(a, auth), { prefix: '/auth' });
      await api.register((a) => machineRoutes(a, repos), { prefix: '/machines' });
      await api.register((a) => projectRoutes(a, repos), { prefix: '/projects' });
      await api.register((a) => projectTaskRoutes(a, repos), { prefix: '/projects' });
      await api.register((a) => noteRoutes(a, repos), { prefix: '/projects' });
      await api.register((a) => taskRoutes(a, repos), { prefix: '/tasks' });
      await api.register((a) => dashboardRoutes(a, repos), { prefix: '/dashboard' });
      await api.register((a) => integrationRoutes(a, repos), { prefix: '/integrations' });
      await api.register((a) => setupRoutes(a, repos), { prefix: '/projects' });
      await api.register((a) => projectTicketRoutes(a, repos), { prefix: '/projects' });
      await api.register((a) => taskTicketRoutes(a, repos), { prefix: '/tasks' });
      await api.register((a) => tabRoutes(a, repos), { prefix: '/tabs' });
      await api.register((a) => aiAccountRoutes(a, repos), { prefix: '/ai-accounts' });
      await api.register(systemRoutes, { prefix: '/system' });
      api.get('/health', { config: { public: true } }, async () => ({ ok: true }));
      api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Rota não encontrada', code: 'NOT_FOUND' }));
    },
    { prefix: '/api' },
  );

  // --- Frontend buildado (produção) ---
  const webDist = path.join(ROOT_DIR, 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await fastify.register(fastifyStatic, { root: webDist, prefix: '/', index: ['index.html'] });
    // SPA fallback: qualquer rota não-API devolve o index.html
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
        return reply.code(404).send({ error: 'Não encontrado' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    fastify.log.warn('web/dist não encontrado — rodando só a API (use "npm run build" para servir o frontend)');
  }

  // --- WebSocket dos terminais ---
  attachTerminalWebSocket(fastify.server, { repos, auth, log: fastify.log });

  // Limpeza periódica de sessões expiradas
  const purge = setInterval(() => void authService.purgeExpired().catch(() => {}), 60 * 60 * 1000);
  const stopSync = startTicketSyncScheduler(repos, fastify.log);
  fastify.addHook('onClose', async () => {
    clearInterval(purge);
    stopSync();
    await closePrisma();
  });

  return { fastify, repos, auth };
}
