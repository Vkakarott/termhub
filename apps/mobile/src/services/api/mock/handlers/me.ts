// Authenticated device/account routes (P§6, design spec §4.2): `me`, `devices/self`,
// `devices/self/revoke`, `push-token`. All go through `verifyAuth`.
import { pushTokenBody } from '../../contract';
import type { MockRouter } from '../router';
import { type MockDevice, type MockState, verifyAuth } from '../state';

/** P§6's fixed permission list for the mobile role (ruling 7). */
const PERMISSIONS = [
  'chat:read',
  'chat:create',
  'chat:update',
  'devices:read',
  'devices:update',
  'devices:delete',
  'terminals:read',
  'terminals:create',
];

function deviceSelf(device: MockDevice) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    model: device.model,
    created_at: new Date(device.createdAt).toISOString(),
    last_seen_at: null,
  };
}

export function registerMeRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/me', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return {
      status: 200,
      body: {
        user: { id: device.userId, email: device.email, name: 'Pedro' },
        permissions: PERMISSIONS,
        device: deviceSelf(device),
      },
    };
  });

  router.route('GET', '/api/m/v1/devices/self', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: deviceSelf(device) };
  });

  router.route('POST', '/api/m/v1/devices/self/revoke', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    device.status = 'revoked';
    device.revokedReason = 'user';
    return { status: 200, body: {} };
  });

  router.route('PUT', '/api/m/v1/push-token', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'PUT', htu: ctx.htu, now: ctx.now() });
    const body = pushTokenBody.parse(ctx.body);
    device.pushToken = body.token;
    return { status: 200, body: {} };
  });
}
