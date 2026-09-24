import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { HostAgents } from '../chat/host.js';
import type { ChatService } from '../chat/service.js';
import type { TranscriptionService } from '../terminal/transcription.js';
import type { Mailer } from '../email/mailer.js';
import type { createUpgradeRouter } from '../ws/router.js';
import { actionForMethod, type Resource } from '../auth/permissions.js';
import { buildMobileAuthHook, type MobileAuthMode } from './auth.js';
import { JtiCache } from './dpop.js';

export const MOBILE_PREFIX = '/api/m/v1';

/** Long-lived state of the mobile API, created once per server (later tasks add enrolment, session, revoke, sockets, push). */
export interface MobileServices {
  jtis: JtiCache;
}

export interface MobileDeps {
  repos: Repositories;
  agents: HostAgents;
  chat: ChatService;
  transcriptions: TranscriptionService;
  mailer: Mailer;
  log: FastifyBaseLogger;
  upgrades: ReturnType<typeof createUpgradeRouter>;
}

/**
 * Registers a route plugin under a permission resource, like `guarded` in the root app.ts: every
 * route gets config.resource, an action derived from the HTTP method unless it sets its own, and
 * `mobileAuth` ('device' unless the route says otherwise).
 */
export type GuardedMobile = (resource: Resource, plugin: (a: FastifyInstance) => Promise<void>, prefix: string) => Promise<void>;

export function createMobileServices(_deps: MobileDeps): MobileServices {
  return { jtis: new JtiCache() };
}

/**
 * The mobile app's API at /api/m/v1. It lives outside the /api plugin on purpose, so the cookie /
 * Cloudflare `buildAuthHook` never runs here: its only authentication is the device token plus a
 * DPoP proof (`buildMobileAuthHook`). Registered only when `config.mobile` is set.
 */
export async function registerMobileApi(
  fastify: FastifyInstance,
  services: MobileServices,
  deps: MobileDeps,
  routes?: (guardedMobile: GuardedMobile, m: FastifyInstance) => Promise<void>,
): Promise<void> {
  const mobile = config.mobile;
  if (!mobile) throw new Error('registerMobileApi requires config.mobile (MOBILE_PUBLIC_URL)');
  await fastify.register(
    async (m) => {
      m.addHook('preHandler', buildMobileAuthHook({ repos: deps.repos, publicUrl: mobile.publicUrl, minAppVersion: mobile.minAppVersion, jtis: services.jtis }));

      const guardedMobile: GuardedMobile = async (resource, plugin, prefix) => {
        await m.register(
          async (a) => {
            a.addHook('onRoute', (route) => {
              const cfg = (route.config ?? {}) as { resource?: string; action?: string; mobileAuth?: MobileAuthMode };
              route.config = {
                ...cfg,
                resource: cfg.resource ?? resource,
                action: cfg.action ?? actionForMethod(String(route.method)),
                mobileAuth: cfg.mobileAuth ?? 'device',
              };
            });
            await plugin(a);
          },
          { prefix },
        );
      };

      // Routes are added by later tasks through `routes`.
      if (routes) await routes(guardedMobile, m);
      m.get('/health', { config: { mobileAuth: 'none' } }, async () => ({ ok: true }));
      m.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Rota não encontrada', code: 'NOT_FOUND' }));
    },
    { prefix: MOBILE_PREFIX },
  );
}
