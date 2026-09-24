import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { DevicesRepository } from './devices.js';
import { DeviceRequestsRepository } from './device-requests.js';

const HOUR = 60 * 60 * 1000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('DevicesRepository / DeviceRequestsRepository (Postgres)', () => {
  let db: PrismaClient;
  let devices: DevicesRepository;
  let requests: DeviceRequestsRepository;
  let userId: string;
  let otherId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    devices = new DevicesRepository(db);
    requests = new DeviceRequestsRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    otherId = newId();
    await db.user.createMany({
      data: [
        { id: userId, email: `${userId}@test.local`, name: 'me' },
        { id: otherId, email: `${otherId}@test.local`, name: 'other' },
      ],
    });
    return async () => {
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); // cascades devices and requests
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const makeDevice = (owner: string, over: { name?: string; keyThumbprint?: string; requestId?: string | null; pinSecretEnc?: string } = {}) =>
    devices.create({
      user_id: owner,
      name: over.name ?? 'iPhone',
      platform: 'ios',
      model: 'iPhone16,1',
      os_version: '18.0',
      app_version: '1.0.0',
      public_key: `pk_${newId()}`,
      key_thumbprint: over.keyThumbprint ?? `thumb_${newId()}`,
      pin_secret_enc: over.pinSecretEnc ?? `enc_${newId()}`,
      request_id: over.requestId ?? null,
    });

  const makeRequest = (owner: string | null, over: { status?: 'pending' | 'approved' | 'denied' | 'expired' | 'activated'; expiresAt?: Date; activateUntil?: Date | null } = {}) =>
    requests.create({
      user_id: owner,
      email_hash: `h_${newId()}`,
      public_key: `pk_${newId()}`,
      key_thumbprint: `thumb_${newId()}`,
      platform: 'ios',
      model: 'iPhone16,1',
      os_version: '18.0',
      device_name: 'iPhone de Fulano',
      app_version: '1.0.0',
      verification_code: '123456',
      request_secret_hash: `rh_${newId()}`,
      status: over.status,
      ip: '203.0.113.1',
      country: 'BR',
      city: 'São Paulo',
      expires_at: over.expiresAt ?? new Date(Date.now() + HOUR),
      activate_until: over.activateUntil ?? null,
    });

  it('creates a device and reads it back without the PIN secret; pinSecretEnc still returns it', async () => {
    const secret = `enc_${newId()}`;
    const created = await makeDevice(userId, { pinSecretEnc: secret });
    const found = await devices.findActiveById(created.id);
    expect(found).toBeDefined();
    expect(JSON.stringify(found)).not.toContain('pin_secret');
    expect(Object.keys(found!)).not.toContain('pin_secret_enc');
    expect(await devices.pinSecretEnc(created.id)).toBe(secret);
  });

  it('rejects a second device with the same key_thumbprint (P2002)', async () => {
    const thumb = `thumb_${newId()}`;
    await makeDevice(userId, { keyThumbprint: thumb });
    await expect(makeDevice(userId, { keyThumbprint: thumb })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('records PIN failures atomically and resets them', async () => {
    const d = await makeDevice(userId);
    expect(await devices.recordPinFailure(d.id)).toEqual({ failures: 1 });
    expect(await devices.recordPinFailure(d.id)).toEqual({ failures: 2 });

    await devices.lockUntil(d.id, new Date(Date.now() + HOUR));
    await devices.resetPin(d.id);

    const after = await devices.findById(d.id);
    expect(after?.pin_failures).toBe(0);
    expect(after?.pin_locked_until).toBeNull();
  });

  it('revokes a device once; a second revoke is undefined; countActive and findActiveById reflect it', async () => {
    const d = await makeDevice(userId);
    expect(await devices.countActive(userId)).toBe(1);

    const revoked = await devices.revoke(d.id, 'user', new Date());
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revoked_at).not.toBeNull();

    expect(await devices.revoke(d.id, 'user', new Date())).toBeUndefined();
    expect(await devices.countActive(userId)).toBe(0);
    expect(await devices.findActiveById(d.id)).toBeUndefined();
  });

  it('decide is undefined for another user, an expired request, or one already decided; succeeds once for a pending request of the owner', async () => {
    const now = new Date();
    const activateUntil = new Date(now.getTime() + HOUR);

    const mine = await makeRequest(userId);
    expect(await requests.decide(mine.id, otherId, 'approved', now, activateUntil)).toBeUndefined();

    const expired = await makeRequest(userId, { expiresAt: new Date(now.getTime() - 1000) });
    expect(await requests.decide(expired.id, userId, 'approved', now, activateUntil)).toBeUndefined();

    const decided = await requests.decide(mine.id, userId, 'approved', now, activateUntil);
    expect(decided?.status).toBe('approved');
    expect(decided?.activate_until).toBe(activateUntil.toISOString());
    expect(decided?.decided_at).toBe(now.toISOString());

    // Already decided: a second decide call finds nothing pending to change.
    expect(await requests.decide(mine.id, userId, 'denied', now, null)).toBeUndefined();
  });

  it('expireOlderThan moves stale pending and approved rows to expired, and leaves an in-window approved row alone', async () => {
    const now = new Date();
    const stalePending = await makeRequest(userId, { expiresAt: new Date(now.getTime() - 1000) });
    const staleApproved = await makeRequest(userId, { status: 'approved', activateUntil: new Date(now.getTime() - 1000) });
    const freshApproved = await makeRequest(userId, { status: 'approved', activateUntil: new Date(now.getTime() + HOUR) });

    const count = await requests.expireOlderThan(now);
    expect(count).toBe(2);

    expect((await requests.findById(stalePending.id))?.status).toBe('expired');
    expect((await requests.findById(staleApproved.id))?.status).toBe('expired');
    expect((await requests.findById(freshApproved.id))?.status).toBe('approved');
  });

  it('markActivated flips an approved row once; a pending row or a second call is a no-op', async () => {
    const pending = await makeRequest(userId);
    expect(await requests.markActivated(pending.id)).toBe(false);
    expect((await requests.findById(pending.id))?.status).toBe('pending');

    const approved = await makeRequest(userId, { status: 'approved', activateUntil: new Date(Date.now() + HOUR) });
    expect(await requests.markActivated(approved.id)).toBe(true);
    expect((await requests.findById(approved.id))?.status).toBe('activated');

    expect(await requests.markActivated(approved.id)).toBe(false);
    expect((await requests.findById(approved.id))?.status).toBe('activated');
  });
});
