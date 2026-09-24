import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notificationRow, notificationsResponse } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import { notFound } from '../lib/errors.js';

const PAGE = 50;
const listQuery = z.object({ before: z.string().datetime().optional() });
const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * The app's Notificações tab, mounted at `/notifications` (spec §9). Always the caller's own rows:
 * every read and write is keyed by `request.scope.user.id`.
 */
export async function mobileNotificationRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async (request) => {
    const { before } = listQuery.parse(request.query ?? {});
    const userId = request.scope.user.id;
    const [rows, unread] = await Promise.all([repos.userNotifications.list(userId, before ? new Date(before) : null, PAGE), repos.userNotifications.countUnread(userId)]);
    return notificationsResponse.parse({
      notifications: rows.map((n) => notificationRow.parse({ id: n.id, kind: n.kind, title: n.title, body: n.body, data: n.data, created_at: n.created_at, read_at: n.read_at })),
      unread,
      next_before: rows.length === PAGE ? rows[rows.length - 1].created_at : null,
    });
  });

  // Clearing one's own badge is part of reading the list, so it needs chat:read, not chat:create.
  app.post('/:id/read', { config: { action: 'read' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const userId = request.scope.user.id;
    // Idempotent: a double tap, or opening the push after the in-app tap, finds the row already read
    // and still answers ok. 404 only when the caller has no such row at all.
    if (!(await repos.userNotifications.markRead(id, userId, new Date())) && !(await repos.userNotifications.existsForUser(id, userId))) {
      throw notFound('Notificação não encontrada');
    }
    return { ok: true as const };
  });
}
