import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { EnrolmentService } from './enrolment.js';
import { purgeMobile } from './purge.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('purgeMobile', () => {
  it('expires requests, then purges each table with its own cutoff and returns the sum', async () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const enrolment = { expire: vi.fn(async () => 1) };
    const repos = {
      deviceSessions: { purgeExpired: vi.fn(async () => 2) },
      deviceRequests: { purgeBefore: vi.fn(async () => 3) },
      deviceEvents: { purgeBefore: vi.fn(async () => 4) },
      userNotifications: { purgeBefore: vi.fn(async () => 5) },
    };

    const total = await purgeMobile(repos as unknown as Repositories, enrolment as unknown as EnrolmentService, now);

    expect(total).toBe(15);
    expect(enrolment.expire).toHaveBeenCalledOnce();
    expect(repos.deviceSessions.purgeExpired).toHaveBeenCalledWith(now);
    expect(repos.deviceRequests.purgeBefore).toHaveBeenCalledWith(new Date(now.getTime() - DAY));
    expect(repos.deviceEvents.purgeBefore).toHaveBeenCalledWith(new Date(now.getTime() - 90 * DAY));
    expect(repos.userNotifications.purgeBefore).toHaveBeenCalledWith(new Date(now.getTime() - 30 * DAY));
  });

  it('expires the requests before purging them, so an expired row still gets its trail', async () => {
    const order: string[] = [];
    const enrolment = { expire: vi.fn(async () => (order.push('expire'), 0)) };
    const repos = {
      deviceSessions: { purgeExpired: vi.fn(async () => 0) },
      deviceRequests: { purgeBefore: vi.fn(async () => (order.push('requests'), 0)) },
      deviceEvents: { purgeBefore: vi.fn(async () => 0) },
      userNotifications: { purgeBefore: vi.fn(async () => 0) },
    };
    await purgeMobile(repos as unknown as Repositories, enrolment as unknown as EnrolmentService, new Date());
    expect(order).toEqual(['expire', 'requests']);
  });
});
