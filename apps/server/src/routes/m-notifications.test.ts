import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { UserNotification } from '../db/repositories/user-notifications.js';
import { applyErrorHandler } from '../lib/errors.js';
import { mobileNotificationRoutes } from './m-notifications.js';

const user = { id: 'u1', email: 'ana@example.com' };

const row = (i: number): UserNotification => ({
  id: `n${i}`,
  user_id: 'u1',
  kind: 'reply',
  title: 'Resposta pronta',
  body: 'O chat geral terminou de responder.',
  data: { kind: 'reply', conversation_id: 'c1', project_id: null },
  created_at: new Date(Date.UTC(2026, 8, 24, 12, 0, 0) - i * 1000).toISOString(),
  read_at: null,
});

function buildApp(rows: UserNotification[], markRead = true) {
  const userNotifications = {
    list: vi.fn(async () => rows),
    countUnread: vi.fn(async () => 7),
    markRead: vi.fn(async () => markRead),
  };
  const repos = { userNotifications } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  app.register((a) => mobileNotificationRoutes(a, repos), { prefix: '/notifications' });
  return { app, userNotifications };
}

describe('GET /notifications', () => {
  it('returns the rows newest first with unread and no cursor when fewer than 50 came back', async () => {
    const rows = [row(0), row(1)];
    const { app, userNotifications } = buildApp(rows);
    const r = await app.inject({ method: 'GET', url: '/notifications' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ notifications: rows.map(({ user_id: _u, ...rest }) => rest), unread: 7, next_before: null });
    expect(userNotifications.list).toHaveBeenCalledWith('u1', null, 50);
    expect(userNotifications.countUnread).toHaveBeenCalledWith('u1');
  });

  it('passes the before cursor and returns the last created_at as next_before when 50 came back', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    const { app, userNotifications } = buildApp(rows);
    const before = '2026-09-24T13:00:00.000Z';
    const r = await app.inject({ method: 'GET', url: `/notifications?before=${encodeURIComponent(before)}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().next_before).toBe(rows[49].created_at);
    expect(userNotifications.list).toHaveBeenCalledWith('u1', new Date(before), 50);
  });

  it('rejects a malformed cursor with 400', async () => {
    const { app, userNotifications } = buildApp([]);
    const r = await app.inject({ method: 'GET', url: '/notifications?before=ontem' });
    expect(r.statusCode).toBe(400);
    expect(userNotifications.list).not.toHaveBeenCalled();
  });
});

describe('POST /notifications/:id/read', () => {
  it('marks the caller’s own row read', async () => {
    const { app, userNotifications } = buildApp([]);
    const r = await app.inject({ method: 'POST', url: '/notifications/n1/read' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(userNotifications.markRead).toHaveBeenCalledWith('n1', 'u1', expect.any(Date));
  });

  it('answers 404 when the row is not the caller’s (or already read)', async () => {
    const { app } = buildApp([], false);
    const r = await app.inject({ method: 'POST', url: '/notifications/n9/read' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: 'Notificação não encontrada', code: 'NOT_FOUND' });
  });
});
