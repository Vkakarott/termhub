import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import { hashToken, safeEqual } from '../auth/tokens.js';
import { decryptSecret } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { newChallenge, newMobileToken, pinProofFor } from './codes.js';
import type { RevokeInput } from './revocation.js';

// The session model (spec §5–§6): a 15-minute access token is renewed only with the device's
// hardware-key signature (checked by the route) AND a proof derived from the PIN-unlocked secret,
// which the SERVER counts: 3 wrong proofs lock the device for 15 minutes, 6 revoke it as hijacked.
// Never log a challenge, a proof, a token or a pin secret.

export const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
export const CHALLENGE_TTL_MS = 60_000;
export const PIN_LOCK_AT = 3;
export const PIN_LOCK_MS = 15 * 60_000;
export const PIN_REVOKE_AT = 6;

export type PinCheck =
  | { ok: true }
  | { ok: false; code: 'DEVICE_LOCKED'; retryAfterMs: number }
  | { ok: false; code: 'PIN_INVALID'; failures: number }
  | { ok: false; code: 'DEVICE_REVOKED' };

/** 423: the device is locked by wrong PIN proofs; the route turns `retryAfterMs` into `retry-after`. */
export class DeviceLockedError extends HttpError {
  constructor(public readonly retryAfterMs: number) {
    super(423, 'Aparelho bloqueado por tentativas de PIN', 'DEVICE_LOCKED');
  }
}

/** 401: a wrong PIN proof; `failures` is the server's count so far, which the app shows. */
export class PinInvalidError extends HttpError {
  constructor(public readonly failures: number) {
    super(401, 'PIN incorreto', 'PIN_INVALID');
  }
}

export const deviceRevoked = () => new HttpError(401, 'Este aparelho foi removido da conta', 'DEVICE_REVOKED');
export const deviceNotFound = () => new HttpError(404, 'Aparelho não encontrado', 'DEVICE_NOT_FOUND');

export interface SessionServiceDeps {
  repos: Repositories;
  revoke: (deviceId: string, input: RevokeInput) => Promise<unknown>;
  now?: () => Date;
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** A single-use, 60-second challenge for a refresh or for a decision on `actionId`. Stored hashed. */
  async challenge(deviceId: string, purpose: 'refresh' | 'decision', actionId: string | null): Promise<{ challenge: string; expires_at: string }> {
    const { repos } = this.deps;
    const device = await repos.devices.findActiveById(deviceId);
    if (!device) {
      const any = await repos.devices.findById(deviceId);
      if (any?.status === 'revoked') throw deviceRevoked();
      throw deviceNotFound();
    }
    const challenge = newChallenge();
    const expiresAt = new Date(this.now().getTime() + CHALLENGE_TTL_MS);
    await repos.deviceSessions.createChallenge(device.id, hashToken(challenge), purpose, actionId, expiresAt);
    return { challenge, expires_at: expiresAt.toISOString() };
  }

  /** Verifies the pin proof for `message` and counts. Call ONLY after the device signature was verified. */
  async checkPin(device: Device, message: string, pinProof: string, ctx: { ip: string | null }): Promise<PinCheck> {
    const { repos } = this.deps;
    const now = this.now();
    // Re-read: the caller's row may be stale (a lock or a revoke from a concurrent attempt).
    const fresh = await repos.devices.findActiveById(device.id);
    if (!fresh) return { ok: false, code: 'DEVICE_REVOKED' };
    if (fresh.pin_locked_until) {
      const until = new Date(fresh.pin_locked_until);
      if (until > now) return { ok: false, code: 'DEVICE_LOCKED', retryAfterMs: until.getTime() - now.getTime() };
    }
    const enc = await repos.devices.pinSecretEnc(device.id);
    if (!enc) throw new Error('device has no pin secret');
    const expected = pinProofFor(decryptSecret(enc), message);
    if (safeEqual(expected, pinProof)) {
      await repos.devices.resetPin(device.id);
      return { ok: true };
    }
    const { failures } = await repos.devices.recordPinFailure(device.id);
    await repos.deviceEvents.record({ user_id: device.user_id, device_id: device.id, kind: 'pin_failed', actor: 'user', ip: ctx.ip, meta: { failures } });
    if (failures >= PIN_REVOKE_AT) {
      await this.deps.revoke(device.id, { reason: 'pin_bruteforce', actor: 'system', ip: ctx.ip });
      return { ok: false, code: 'DEVICE_REVOKED' };
    }
    if (failures === PIN_LOCK_AT) {
      await repos.devices.lockUntil(device.id, new Date(now.getTime() + PIN_LOCK_MS));
      await repos.deviceEvents.record({ user_id: device.user_id, device_id: device.id, kind: 'pin_locked', actor: 'system', ip: ctx.ip });
      return { ok: false, code: 'DEVICE_LOCKED', retryAfterMs: PIN_LOCK_MS };
    }
    return { ok: false, code: 'PIN_INVALID', failures };
  }

  /**
   * Renews the access token. The caller (the token route) has already verified the device's DPoP
   * signature over this challenge; the challenge is consumed BEFORE the PIN is checked, so an
   * invalid or replayed challenge never counts an attempt.
   */
  async refresh(input: { device: Device; challenge: string; pin_proof: string }, ctx: { ip: string | null }): Promise<{ access_token: string; expires_in: number }> {
    const { repos } = this.deps;
    const { device } = input;
    const consumed = await repos.deviceSessions.consumeChallenge(device.id, hashToken(input.challenge), 'refresh', this.now());
    if (!consumed) throw new HttpError(400, 'Desafio inválido ou expirado', 'CHALLENGE_INVALID');

    const pin = await this.checkPin(device, input.challenge, input.pin_proof, ctx);
    if (!pin.ok) {
      if (pin.code === 'DEVICE_LOCKED') throw new DeviceLockedError(pin.retryAfterMs);
      if (pin.code === 'PIN_INVALID') throw new PinInvalidError(pin.failures);
      throw deviceRevoked();
    }

    const accessToken = newMobileToken();
    await repos.deviceSessions.createToken(device.id, hashToken(accessToken), new Date(this.now().getTime() + ACCESS_TOKEN_TTL_MS));
    await repos.deviceEvents.record({ user_id: device.user_id, device_id: device.id, kind: 'token_refreshed', actor: 'user', ip: ctx.ip });
    return { access_token: accessToken, expires_in: ACCESS_TOKEN_TTL_MS / 1000 };
  }

  /** Consumes a decision challenge; true only when it was issued for this very action. */
  async consumeDecisionChallenge(device: Device, challenge: string, actionId: string): Promise<boolean> {
    const consumed = await this.deps.repos.deviceSessions.consumeChallenge(device.id, hashToken(challenge), 'decision', this.now());
    return consumed !== undefined && consumed.action_id === actionId;
  }
}
