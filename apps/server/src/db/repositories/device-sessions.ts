import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapDevice, type Device } from './devices.js';

export type DeviceChallengePurpose = 'refresh' | 'decision';

export class DeviceSessionsRepository {
  constructor(private db: PrismaClient) {}

  async createToken(deviceId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.deviceToken.create({ data: { id: newId(), deviceId, tokenHash, expiresAt } });
  }

  /** An unexpired token of a still-active device — the everyday auth check. */
  async findValidToken(tokenHash: string, now: Date): Promise<{ device: Device } | undefined> {
    const t = await this.db.deviceToken.findFirst({
      where: { tokenHash, expiresAt: { gt: now }, device: { status: 'active' } },
      include: { device: true },
    });
    return t ? { device: mapDevice(t.device) } : undefined;
  }

  /**
   * The same lookup as `findValidToken` but with no expiry or device-status filter, so the auth
   * hook can tell "revoked device" (token found, device not active) apart from "unknown token"
   * (nothing found) — the two need different responses.
   */
  async findTokenAny(tokenHash: string): Promise<{ device_id: string } | undefined> {
    const t = await this.db.deviceToken.findFirst({ where: { tokenHash } });
    return t ? { device_id: t.deviceId } : undefined;
  }

  async deleteTokensForDevice(deviceId: string): Promise<number> {
    const r = await this.db.deviceToken.deleteMany({ where: { deviceId } });
    return r.count;
  }

  async createChallenge(deviceId: string, challengeHash: string, purpose: DeviceChallengePurpose, actionId: string | null, expiresAt: Date): Promise<void> {
    await this.db.deviceChallenge.create({ data: { id: newId(), deviceId, challengeHash, purpose, actionId, expiresAt } });
  }

  /**
   * Consumes a challenge exactly once: conditional on it being unused and unexpired, so concurrent
   * calls for the same challenge (a retried request) leave exactly one winner — the database's row
   * lock, not application code, decides.
   */
  async consumeChallenge(deviceId: string, challengeHash: string, purpose: DeviceChallengePurpose, now: Date): Promise<{ action_id: string | null } | undefined> {
    const { count } = await this.db.deviceChallenge.updateMany({
      where: { deviceId, challengeHash, purpose, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count === 0) return undefined;
    const c = await this.db.deviceChallenge.findFirst({ where: { deviceId, challengeHash } });
    return c ? { action_id: c.actionId } : undefined;
  }

  async purgeExpired(now: Date): Promise<number> {
    const [tokens, challenges] = await Promise.all([
      this.db.deviceToken.deleteMany({ where: { expiresAt: { lt: now } } }),
      this.db.deviceChallenge.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);
    return tokens.count + challenges.count;
  }
}
