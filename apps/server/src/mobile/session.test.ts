import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // encryptSecret/decryptSecret need a key; config reads the env at import time.
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import type { DeviceChallengePurpose } from '../db/repositories/device-sessions.js';
import { hashToken } from '../auth/tokens.js';
import { encryptSecret } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { newPinSecret, pinProofFor } from './codes.js';
import type { RevokeInput } from './revocation.js';
import { ACCESS_TOKEN_TTL_MS, CHALLENGE_TTL_MS, DeviceLockedError, PIN_LOCK_MS, PinInvalidError, SessionService } from './session.js';

const T0 = new Date('2026-09-24T12:00:00.000Z');
const ctx = { ip: '1.2.3.4' };
const SECRET = newPinSecret();

const mkDevice = (overrides: Partial<Device> = {}): Device => ({
  id: 'd1',
  user_id: 'u1',
  name: 'iPhone de Ana',
  platform: 'ios',
  model: 'iPhone 15',
  os_version: '18.0',
  app_version: '1.0.0+1',
  public_key: '{}',
  key_thumbprint: 'thumb',
  pin_failures: 0,
  pin_locked_until: null,
  status: 'active',
  revoked_at: null,
  revoked_reason: null,
  push_token: null,
  last_seen_at: null,
  last_ip: null,
  request_id: null,
  created_at: T0.toISOString(),
  ...overrides,
});

interface ChallengeRow {
  device_id: string;
  hash: string;
  purpose: DeviceChallengePurpose;
  action_id: string | null;
  expires_at: Date;
}

function build(opts: { device?: Device | undefined; revoked?: boolean } = {}) {
  let device: Device | undefined = 'device' in opts ? opts.device : mkDevice();
  let clock = T0;
  const challenges: ChallengeRow[] = [];
  const repos = {
    devices: {
      findActiveById: vi.fn(async (id: string) => (device && device.id === id && device.status === 'active' ? { ...device } : undefined)),
      findById: vi.fn(async (id: string) => (device && device.id === id ? { ...device } : undefined)),
      pinSecretEnc: vi.fn(async () => encryptSecret(SECRET)),
      recordPinFailure: vi.fn(async () => {
        device = { ...device!, pin_failures: device!.pin_failures + 1 };
        return { failures: device.pin_failures };
      }),
      lockUntil: vi.fn(async (_id: string, until: Date) => {
        device = { ...device!, pin_locked_until: until.toISOString() };
      }),
      resetPin: vi.fn(async () => {
        device = { ...device!, pin_failures: 0, pin_locked_until: null };
      }),
    },
    deviceSessions: {
      createToken: vi.fn(async () => undefined),
      createChallenge: vi.fn(async (device_id: string, hash: string, purpose: DeviceChallengePurpose, action_id: string | null, expires_at: Date) => {
        challenges.push({ device_id, hash, purpose, action_id, expires_at });
      }),
      consumeChallenge: vi.fn(async (deviceId: string, hash: string, purpose: DeviceChallengePurpose, now: Date) => {
        const i = challenges.findIndex((c) => c.device_id === deviceId && c.hash === hash && c.purpose === purpose && c.expires_at > now);
        if (i < 0) return undefined;
        const [c] = challenges.splice(i, 1);
        return { action_id: c.action_id };
      }),
    },
    deviceEvents: { record: vi.fn(async () => undefined) },
  };
  const revoke = vi.fn(async (id: string, _input: RevokeInput) => {
    if (device && device.id === id) device = { ...device, status: 'revoked' };
    return device;
  });
  if (opts.revoked && device) device = { ...device, status: 'revoked' };
  const service = new SessionService({ repos: repos as unknown as Repositories, revoke, now: () => clock });
  return {
    service,
    repos,
    revoke,
    challenges,
    current: () => device!,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function httpError(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error('expected an HttpError');
}

describe('SessionService.challenge', () => {
  it('creates a hashed challenge row that expires in 60 s and returns the plain challenge', async () => {
    const { service, repos } = build();
    const r = await service.challenge('d1', 'refresh', null);
    expect(r.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.expires_at).toBe(new Date(T0.getTime() + CHALLENGE_TTL_MS).toISOString());
    expect(CHALLENGE_TTL_MS).toBe(60_000);
    expect(repos.deviceSessions.createChallenge).toHaveBeenCalledWith('d1', hashToken(r.challenge), 'refresh', null, new Date(T0.getTime() + 60_000));
  });

  it('404 DEVICE_NOT_FOUND for an unknown device, 401 DEVICE_REVOKED for a revoked one', async () => {
    expect((await httpError(build({ device: undefined }).service.challenge('d1', 'refresh', null))).code).toBe('DEVICE_NOT_FOUND');
    const e = await httpError(build({ revoked: true }).service.challenge('d1', 'refresh', null));
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe('DEVICE_REVOKED');
  });
});

describe('SessionService.refresh', () => {
  it('with a valid challenge and the right proof, issues a 15-minute token, resets the PIN and records token_refreshed', async () => {
    const { service, repos } = build();
    const { challenge } = await service.challenge('d1', 'refresh', null);
    const r = await service.refresh({ device: mkDevice(), challenge, pin_proof: pinProofFor(SECRET, challenge) }, ctx);
    expect(r.access_token).toMatch(/^thb_mob_/);
    expect(r.expires_in).toBe(900);
    expect(ACCESS_TOKEN_TTL_MS).toBe(15 * 60_000);
    expect(repos.deviceSessions.createToken).toHaveBeenCalledWith('d1', hashToken(r.access_token), new Date(T0.getTime() + 15 * 60_000));
    expect(repos.devices.resetPin).toHaveBeenCalledWith('d1');
    expect(repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'token_refreshed', device_id: 'd1', user_id: 'u1' }));
  });

  it('an unknown/consumed challenge is 400 CHALLENGE_INVALID and never counts a PIN attempt', async () => {
    const { service, repos } = build();
    const e = await httpError(service.refresh({ device: mkDevice(), challenge: 'nope', pin_proof: 'wrong' }, ctx));
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe('CHALLENGE_INVALID');
    expect(repos.devices.recordPinFailure).not.toHaveBeenCalled();
    expect(repos.devices.pinSecretEnc).not.toHaveBeenCalled();
  });

  it('a challenge is single-use', async () => {
    const { service } = build();
    const { challenge } = await service.challenge('d1', 'refresh', null);
    await service.refresh({ device: mkDevice(), challenge, pin_proof: pinProofFor(SECRET, challenge) }, ctx);
    const e = await httpError(service.refresh({ device: mkDevice(), challenge, pin_proof: pinProofFor(SECRET, challenge) }, ctx));
    expect(e.code).toBe('CHALLENGE_INVALID');
  });

  it('counts wrong proofs: 1-2 PIN_INVALID, 3 locks for 15 min (423), locked attempts are not counted, 6 revokes', async () => {
    const t = build();
    const attempt = async (proof?: string) => {
      const { challenge } = await t.service.challenge('d1', 'refresh', null);
      return t.service.refresh({ device: mkDevice(), challenge, pin_proof: proof ?? pinProofFor(newPinSecret(), challenge) }, ctx);
    };

    for (const n of [1, 2]) {
      const e = await httpError(attempt());
      expect(e.statusCode).toBe(401);
      expect(e.code).toBe('PIN_INVALID');
      expect(e).toBeInstanceOf(PinInvalidError);
      expect((e as PinInvalidError).failures).toBe(n);
    }
    expect(t.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pin_failed', meta: { failures: 2 } }));

    const locked = await httpError(attempt());
    expect(locked.statusCode).toBe(423);
    expect(locked.code).toBe('DEVICE_LOCKED');
    expect(locked).toBeInstanceOf(DeviceLockedError);
    expect((locked as DeviceLockedError).retryAfterMs).toBe(PIN_LOCK_MS);
    expect(t.repos.devices.lockUntil).toHaveBeenCalledWith('d1', new Date(T0.getTime() + 15 * 60_000));
    expect(t.repos.deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pin_locked', actor: 'system' }));

    // While locked, even the right proof is refused and nothing is counted.
    t.advance(5 * 60_000);
    t.repos.devices.recordPinFailure.mockClear();
    t.repos.devices.pinSecretEnc.mockClear();
    const stillLocked = await httpError(attempt('whatever'));
    expect(stillLocked.statusCode).toBe(423);
    expect((stillLocked as DeviceLockedError).retryAfterMs).toBe(10 * 60_000);
    expect(t.repos.devices.recordPinFailure).not.toHaveBeenCalled();
    expect(t.repos.devices.pinSecretEnc).not.toHaveBeenCalled();

    // After the lock: 4 and 5 are plain PIN_INVALID, 6 revokes the device as hijacked.
    t.advance(10 * 60_000 + 1);
    for (let n = 4; n <= 5; n++) expect((await httpError(attempt())).code).toBe('PIN_INVALID');
    expect(t.revoke).not.toHaveBeenCalled();
    const revoked = await httpError(attempt());
    expect(revoked.statusCode).toBe(401);
    expect(revoked.code).toBe('DEVICE_REVOKED');
    expect(t.revoke).toHaveBeenCalledWith('d1', expect.objectContaining({ reason: 'pin_bruteforce', actor: 'system' }));
    expect(t.repos.deviceSessions.createToken).not.toHaveBeenCalled();
  });
});

describe('SessionService.checkPin', () => {
  it('a proof of the wrong length is PIN_INVALID, never a throw', async () => {
    const { service } = build();
    await expect(service.checkPin(mkDevice(), 'msg', 'x', ctx)).resolves.toEqual({ ok: false, code: 'PIN_INVALID', failures: 1 });
    await expect(service.checkPin(mkDevice(), 'msg', '', ctx)).resolves.toEqual({ ok: false, code: 'PIN_INVALID', failures: 2 });
  });

  it('re-reads the device: a revoked device is DEVICE_REVOKED without comparing', async () => {
    const t = build({ revoked: true });
    await expect(t.service.checkPin(mkDevice(), 'msg', pinProofFor(SECRET, 'msg'), ctx)).resolves.toEqual({ ok: false, code: 'DEVICE_REVOKED' });
    expect(t.repos.devices.pinSecretEnc).not.toHaveBeenCalled();
  });

  it('honours pin_locked_until from the fresh row, not the stale one passed in', async () => {
    const t = build({ device: mkDevice({ pin_locked_until: new Date(T0.getTime() + 60_000).toISOString() }) });
    const r = await t.service.checkPin(mkDevice(), 'msg', pinProofFor(SECRET, 'msg'), ctx);
    expect(r).toEqual({ ok: false, code: 'DEVICE_LOCKED', retryAfterMs: 60_000 });
    expect(t.repos.devices.resetPin).not.toHaveBeenCalled();
  });

  it('the right proof is ok and resets the counter', async () => {
    const t = build();
    await expect(t.service.checkPin(mkDevice(), 'msg', pinProofFor(SECRET, 'msg'), ctx)).resolves.toEqual({ ok: true });
    expect(t.repos.devices.resetPin).toHaveBeenCalledWith('d1');
  });
});

describe('SessionService.consumeDecisionChallenge', () => {
  it('true only for a decision challenge bound to the same action', async () => {
    const t = build();
    const a = await t.service.challenge('d1', 'decision', 'act1');
    expect(await t.service.consumeDecisionChallenge(mkDevice(), a.challenge, 'act1')).toBe(true);
    expect(await t.service.consumeDecisionChallenge(mkDevice(), a.challenge, 'act1')).toBe(false); // single-use

    const b = await t.service.challenge('d1', 'decision', 'act1');
    expect(await t.service.consumeDecisionChallenge(mkDevice(), b.challenge, 'act2')).toBe(false);

    const c = await t.service.challenge('d1', 'refresh', null);
    expect(await t.service.consumeDecisionChallenge(mkDevice(), c.challenge, 'act1')).toBe(false);
  });
});
