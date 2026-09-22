import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { authRoutes } from './routes.js';

const setNickname = vi.fn();

function buildApp(user: { id: string; nickname: string | null }) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
  });
  const repos = { users: { setNickname, findByNickname: vi.fn(async () => undefined) } } as unknown as Repositories;
  app.register((a) => authRoutes(a, { repos } as never), { prefix: '/auth' });
  return app;
}

const patch = (app: ReturnType<typeof buildApp>, nickname: unknown) => app.inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname } });

describe('PATCH /auth/me/nickname', () => {
  beforeEach(() => setNickname.mockReset().mockResolvedValue('ok'));

  it('claims a nickname, lowercased', async () => {
    const res = await patch(buildApp({ id: 'u1', nickname: null }), 'Pedro');
    expect(res.statusCode).toBe(200);
    expect(setNickname).toHaveBeenCalledWith('u1', 'pedro');
    expect(res.json().user.nickname).toBe('pedro');
  });

  it('refuses a reserved word and a bad shape without touching the database', async () => {
    for (const bad of ['city', 'ab', 'pe dro', 'pedro!']) {
      expect((await patch(buildApp({ id: 'u1', nickname: null }), bad)).statusCode).toBe(400);
    }
    expect(setNickname).not.toHaveBeenCalled();
  });

  it('answers 409 when another account already holds it', async () => {
    setNickname.mockResolvedValue('taken');
    const res = await patch(buildApp({ id: 'u2', nickname: null }), 'pedro');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_TAKEN');
  });
});
