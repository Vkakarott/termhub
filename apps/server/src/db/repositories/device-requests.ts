import type { PrismaClient } from '../prisma.js';
import type { DeviceRequest as PrismaDeviceRequest } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type DeviceRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'activated';

/** A phone's enrollment request as routes see it: never the request secret's hash. */
export interface DeviceRequest {
  id: string;
  user_id: string | null;
  email_hash: string;
  public_key: string;
  key_thumbprint: string;
  platform: string;
  model: string;
  os_version: string;
  device_name: string;
  app_version: string;
  verification_code: string;
  status: DeviceRequestStatus;
  ip: string;
  country: string | null;
  city: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  activate_until: string | null;
}

export interface DeviceRequestCreateInput {
  user_id: string | null;
  email_hash: string;
  public_key: string;
  key_thumbprint: string;
  platform: string;
  model: string;
  os_version: string;
  device_name: string;
  app_version: string;
  verification_code: string;
  request_secret_hash: string;
  status?: DeviceRequestStatus;
  ip: string;
  country: string | null;
  city: string | null;
  expires_at: Date;
  activate_until?: Date | null;
}

const mapDeviceRequest = (r: PrismaDeviceRequest): DeviceRequest => ({
  id: r.id,
  user_id: r.userId,
  email_hash: r.emailHash,
  public_key: r.publicKey,
  key_thumbprint: r.keyThumbprint,
  platform: r.platform,
  model: r.model,
  os_version: r.osVersion,
  device_name: r.deviceName,
  app_version: r.appVersion,
  verification_code: r.verificationCode,
  status: r.status as DeviceRequestStatus,
  ip: r.ip,
  country: r.country,
  city: r.city,
  created_at: r.createdAt.toISOString(),
  expires_at: r.expiresAt.toISOString(),
  decided_at: r.decidedAt?.toISOString() ?? null,
  activate_until: r.activateUntil?.toISOString() ?? null,
});

export class DeviceRequestsRepository {
  constructor(private db: PrismaClient) {}

  async create(input: DeviceRequestCreateInput): Promise<DeviceRequest> {
    const r = await this.db.deviceRequest.create({
      data: {
        id: newId(),
        userId: input.user_id,
        emailHash: input.email_hash,
        publicKey: input.public_key,
        keyThumbprint: input.key_thumbprint,
        platform: input.platform,
        model: input.model,
        osVersion: input.os_version,
        deviceName: input.device_name,
        appVersion: input.app_version,
        verificationCode: input.verification_code,
        requestSecretHash: input.request_secret_hash,
        status: input.status ?? 'pending',
        ip: input.ip,
        country: input.country,
        city: input.city,
        expiresAt: input.expires_at,
        activateUntil: input.activate_until ?? null,
      },
    });
    return mapDeviceRequest(r);
  }

  async findById(id: string): Promise<DeviceRequest | undefined> {
    const r = await this.db.deviceRequest.findFirst({ where: { id } });
    return r ? mapDeviceRequest(r) : undefined;
  }

  /** For flows that must verify the request secret (activation): the DTO plus the hash, never
   * mixed into the DTO itself. */
  async findByIdWithSecretHash(id: string): Promise<{ request: DeviceRequest; request_secret_hash: string } | undefined> {
    const r = await this.db.deviceRequest.findFirst({ where: { id } });
    return r ? { request: mapDeviceRequest(r), request_secret_hash: r.requestSecretHash } : undefined;
  }

  async listPendingForUser(userId: string, now: Date): Promise<DeviceRequest[]> {
    const rows = await this.db.deviceRequest.findMany({
      where: { userId, status: 'pending', expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(mapDeviceRequest);
  }

  async countPendingForUser(userId: string, now: Date): Promise<number> {
    return this.db.deviceRequest.count({ where: { userId, status: 'pending', expiresAt: { gt: now } } });
  }

  async countSinceByEmailHash(emailHash: string, since: Date): Promise<number> {
    return this.db.deviceRequest.count({ where: { emailHash, createdAt: { gt: since } } });
  }

  /**
   * Records the account holder's decision. Conditional on the row still being pending, owned by
   * this user, and not yet expired, so a stale approval screen or another user's request never
   * decides it — undefined covers all three at once, same as `ChatActionsRepository.decide`.
   */
  async decide(id: string, userId: string, status: 'approved' | 'denied', now: Date, activateUntil: Date | null): Promise<DeviceRequest | undefined> {
    const { count } = await this.db.deviceRequest.updateMany({
      where: { id, userId, status: 'pending', expiresAt: { gt: now } },
      data: { status, decidedAt: now, activateUntil },
    });
    if (count === 0) return undefined;
    const r = await this.db.deviceRequest.findFirst({ where: { id } });
    return r ? mapDeviceRequest(r) : undefined;
  }

  /** Conditional on the row still being approved — the only legal predecessor — so a second call,
   * a pending/denied row, or a row `expireOlderThan` already flipped to expired is a no-op instead
   * of a silent overwrite. `true` when this call is the one that flipped it. */
  async markActivated(id: string): Promise<boolean> {
    const { count } = await this.db.deviceRequest.updateMany({ where: { id, status: 'approved' }, data: { status: 'activated' } });
    return count === 1;
  }

  /** Pending rows past `expires_at` and approved rows past `activate_until` both become expired. */
  async expireOlderThan(now: Date): Promise<number> {
    const { count } = await this.db.deviceRequest.updateMany({
      where: {
        OR: [
          { status: 'pending', expiresAt: { lte: now } },
          { status: 'approved', activateUntil: { lte: now } },
        ],
      },
      data: { status: 'expired' },
    });
    return count;
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const r = await this.db.deviceRequest.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
