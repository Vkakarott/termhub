import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { HostAgents } from '../chat/host.js';
import type { ChatService } from '../chat/service.js';
import type { TranscriptionService } from '../terminal/transcription.js';
import type { Mailer } from '../email/mailer.js';
import type { createUpgradeRouter } from '../ws/router.js';
import { actionForMethod, type Resource } from '../auth/permissions.js';
import { mobileDeviceRoutes, mobilePushTokenRoutes } from '../routes/m-devices.js';
import { mobileSessionRoutes } from '../routes/m-session.js';
import { buildMobileAuthHook, type MobileAuthMode } from './auth.js';
import { JtiCache } from './dpop.js';
import { EnrolmentService } from './enrolment.js';
import { MobileSocketRegistry, revokeDevice } from './revocation.js';
import { SessionService } from './session.js';

export const MOBILE_PREFIX = '/api/m/v1';

/** Long-lived state of the mobile API, created once per server (later tasks add push). */
export interface MobileServices {
  jtis: JtiCache;
  enrolment: EnrolmentService;
  sockets: MobileSocketRegistry;
  session: SessionService;
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

export function createMobileServices(deps: MobileDeps): MobileServices {
  const sockets = new MobileSocketRegistry();
  const { repos, mailer, log } = deps;
  return {
    jtis: new JtiCache(),
    // `hooks` stays undefined until Task 16 wires push notifications into enrolment.
    enrolment: new EnrolmentService({ repos, mailer, log, appUrl: config.publicUrl }),
    sockets,
    // Six wrong PIN proofs revoke the device through the same path as every other revoke.
    session: new SessionService({ repos, revoke: (id, input) => revokeDevice({ repos, sockets, mailer, log }, id, input) }),
  };
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
  const publicUrl = mobile.publicUrl;
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

      // The mobile API's own routes: enrolment, self-management, push-token and session, all under `devices`.
      async function mobileRoutes(guarded: GuardedMobile): Promise<void> {
        await guarded(
          'devices',
          (a) =>
            mobileDeviceRoutes(a, deps.repos, {
              enrolment: services.enrolment,
              revoke: (id, input) => revokeDevice({ repos: deps.repos, sockets: services.sockets, mailer: deps.mailer, log: deps.log }, id, input),
            }),
          '/devices',
        );
        await guarded('devices', (a) => mobilePushTokenRoutes(a, deps.repos), '');
        // Challenge and token renewal: both mobileAuth 'none', /token verifies the device proof itself.
        await guarded('devices', (a) => mobileSessionRoutes(a, deps.repos, { session: services.session, jtis: services.jtis, publicUrl }), '/session');
      }

      await mobileRoutes(guardedMobile);
      // `routes` stays for tests that want to register extra routes alongside the real ones.
      if (routes) await routes(guardedMobile, m);
      m.get('/health', { config: { mobileAuth: 'none' } }, async () => ({ ok: true }));
      m.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Rota não encontrada', code: 'NOT_FOUND' }));
    },
    { prefix: MOBILE_PREFIX },
  );
}
