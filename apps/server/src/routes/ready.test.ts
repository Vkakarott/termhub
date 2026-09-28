import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createLifecycle, drain } from '../ws/drain.js';
import { readyRoutes } from './ready.js';

function buildApp(ping: () => Promise<void> = async () => {}) {
  const app = Fastify();
  const lifecycle = createLifecycle();
  void app.register((a) => readyRoutes(a, { ping, lifecycle }), { prefix: '/api' });
  const appDrain = () => drain({ lifecycle, suspend: async () => {}, closeAgents: () => 0, servers: [], log: { info: vi.fn(), warn: vi.fn() } as never });
  return { app, drain: appDrain };
}

describe('GET /api/ready', () => {
  it('200 { ok: true } while the database answers', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('503 draining after the app drains', async () => {
    const { app, drain: appDrain } = buildApp();
    await appDrain();
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'draining' });
  });

  it('503 database when the ping fails', async () => {
    const { app } = buildApp(() => Promise.reject(new Error('down')));
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'database' });
  });

  it('is a public route (the auth hook skips it)', async () => {
    const app = Fastify();
    let seen: unknown;
    app.addHook('onRoute', (route) => {
      if (route.url === '/api/ready') seen = route.config;
    });
    await app.register((a) => readyRoutes(a, { ping: async () => {}, lifecycle: createLifecycle() }), { prefix: '/api' });
    await app.ready();
    expect(seen).toMatchObject({ public: true });
  });
});
