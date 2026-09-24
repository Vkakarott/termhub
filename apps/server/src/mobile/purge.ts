import type { Repositories } from '../db/repositories/index.js';
import type { EnrolmentService } from './enrolment.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Device requests are kept a day after they were made (they expire in minutes), for the web's view. */
export const DEVICE_REQUEST_RETENTION_MS = DAY_MS;
/** The device trail (approvals, revokes, refused PINs) is kept for 90 days. */
export const DEVICE_EVENT_RETENTION_MS = 90 * DAY_MS;
/** The Notificações tab shows the last 30 days. */
export const USER_NOTIFICATION_RETENTION_MS = 30 * DAY_MS;

/**
 * The mobile API's hourly clean-up, run from app.ts's purge interval: stale requests become expired
 * first (so they get their `request_expired` trail), then each table drops rows past its retention.
 * Returns how many rows were touched in total.
 */
export async function purgeMobile(
  repos: Pick<Repositories, 'deviceSessions' | 'deviceRequests' | 'deviceEvents' | 'userNotifications'>,
  enrolment: Pick<EnrolmentService, 'expire'>,
  now = new Date(),
): Promise<number> {
  const at = now.getTime();
  const expired = await enrolment.expire();
  const sessions = await repos.deviceSessions.purgeExpired(now);
  const requests = await repos.deviceRequests.purgeBefore(new Date(at - DEVICE_REQUEST_RETENTION_MS));
  const events = await repos.deviceEvents.purgeBefore(new Date(at - DEVICE_EVENT_RETENTION_MS));
  const notifications = await repos.userNotifications.purgeBefore(new Date(at - USER_NOTIFICATION_RETENTION_MS));
  return expired + sessions + requests + events + notifications;
}
