import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { DeviceSessionsRepository } from './device-sessions.js';
import { DevicesRepository } from './devices.js';

const HOUR = 60 * 60 * 1000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('DeviceSessionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let sessions: DeviceSessionsRepository;
  let devices: DevicesRepository;
  let userId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    sessions = new DeviceSessionsRepository(db);
    devices = new DevicesRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'me' } });
    return async () => {
      await db.user.deleteMany({ where: { id: userId } }); // cascades devices, tokens and challenges
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const makeDevice = () =>
    devices.create({
      user_id: userId,
      name: 'iPhone',
      platform: 'ios',
      model: 'iPhone16,1',
      os_version: '18.0',
      app_version: '1.0.0',
      public_key: `pk_${newId()}`,
      key_thumbprint: `thumb_${newId()}`,
      pin_secret_enc: `enc_${newId()}`,
      request_id: null,
    });

  it('consumes a challenge exactly once, even under ten concurrent attempts', async () => {
    const d = await makeDevice();
    const now = new Date();
    const actionId = newId();
    await sessions.createChallenge(d.id, 'ch-1', 'decision', actionId, new Date(now.getTime() + HOUR));

    const first = await sessions.consumeChallenge(d.id, 'ch-1', 'decision', now);
    expect(first).toEqual({ action_id: actionId });
    expect(await sessions.consumeChallenge(d.id, 'ch-1', 'decision', now)).toBeUndefined();

    const d2 = await makeDevice();
    await sessions.createChallenge(d2.id, 'ch-race', 'refresh', null, new Date(now.getTime() + HOUR));
    const results = await Promise.all(Array.from({ length: 10 }, () => sessions.consumeChallenge(d2.id, 'ch-race', 'refresh', now)));
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it('consumeChallenge is undefined for the wrong purpose or after expiry', async () => {
    const d = await makeDevice();
    const now = new Date();
    await sessions.createChallenge(d.id, 'ch-2', 'refresh', null, new Date(now.getTime() + HOUR));
    expect(await sessions.consumeChallenge(d.id, 'ch-2', 'decision', now)).toBeUndefined();
    expect(await sessions.consumeChallenge(d.id, 'ch-2', 'refresh', now)).toEqual({ action_id: null });

    await sessions.createChallenge(d.id, 'ch-3', 'refresh', null, new Date(now.getTime() - 1000));
    expect(await sessions.consumeChallenge(d.id, 'ch-3', 'refresh', now)).toBeUndefined();
  });

  it('findValidToken finds an unexpired token of an active device, not an expired one, and not one of a revoked device', async () => {
    const active = await makeDevice();
    const expiredDevice = await makeDevice();
    const revoked = await makeDevice();
    await devices.revoke(revoked.id, 'user', new Date());

    const now = new Date();
    await sessions.createToken(active.id, 'tok-active', new Date(now.getTime() + HOUR));
    await sessions.createToken(expiredDevice.id, 'tok-expired', new Date(now.getTime() - 1000));
    await sessions.createToken(revoked.id, 'tok-revoked', new Date(now.getTime() + HOUR));

    expect((await sessions.findValidToken('tok-active', now))?.device.id).toBe(active.id);
    expect(await sessions.findValidToken('tok-expired', now)).toBeUndefined();
    expect(await sessions.findValidToken('tok-revoked', now)).toBeUndefined();
    expect(await sessions.findValidToken('tok-unknown', now)).toBeUndefined();
  });

  it('findTokenAny finds a revoked device\'s token (no status filter) and undefined for an unknown hash', async () => {
    const revoked = await makeDevice();
    await sessions.createToken(revoked.id, 'tok-any-revoked', new Date(Date.now() + HOUR));
    await devices.revoke(revoked.id, 'user', new Date());

    expect(await sessions.findTokenAny('tok-any-revoked')).toEqual({ device_id: revoked.id });
    expect(await sessions.findTokenAny('tok-any-unknown')).toBeUndefined();
  });

  it('deleteTokensForDevice removes only that device\'s tokens', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    await sessions.createToken(a.id, 'tok-a', new Date(Date.now() + HOUR));
    await sessions.createToken(b.id, 'tok-b', new Date(Date.now() + HOUR));

    expect(await sessions.deleteTokensForDevice(a.id)).toBe(1);
    expect(await sessions.findTokenAny('tok-a')).toBeUndefined();
    expect(await sessions.findTokenAny('tok-b')).toEqual({ device_id: b.id });
  });

  it('purgeExpired removes tokens and challenges past expiry', async () => {
    const d = await makeDevice();
    const now = new Date();
    await sessions.createToken(d.id, 'tok-old', new Date(now.getTime() - 1000));
    await sessions.createToken(d.id, 'tok-new', new Date(now.getTime() + HOUR));
    await sessions.createChallenge(d.id, 'ch-old', 'refresh', null, new Date(now.getTime() - 1000));
    await sessions.createChallenge(d.id, 'ch-new', 'refresh', null, new Date(now.getTime() + HOUR));

    expect(await sessions.purgeExpired(now)).toBe(2);
    expect(await sessions.findTokenAny('tok-new')).toEqual({ device_id: d.id });
    expect(await sessions.findTokenAny('tok-old')).toBeUndefined();
  });
});
