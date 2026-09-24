// Session routes (P§5.3, design spec §4.2): `session/challenge`, `session/token`. This is where
// PIN failures are counted, so the order below matters (Review Focus 1 of the product spec):
// the DPoP signature is verified — and the jti claimed — before a wrong `pin_proof` ever
// increments `pinFailures`.
import { pinProof } from '../../../crypto/pin';
import { randomId } from '../../../crypto/random';
import { challengeBody, tokenBody } from '../../contract';
import { verifyProof } from '../../dpop';
import type { MockRouter } from '../router';
import { claimJti, revokeDevice, WireError, type MockState } from '../state';

const CHALLENGE_TTL_MS = 60_000;
const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const LOCK_AT = 3;
const REVOKE_AT = 6;

/** `max(0, 3 - failures)` for the first three failures, then the same shape again for the second
 * window (4, 5) once the lock has expired — i.e. 0 exactly on the failure that (re)triggers a
 * lock or a revoke, never a stray 3. */
function attemptsLeft(failures: number): number {
  const remainder = failures % LOCK_AT;
  return remainder === 0 ? 0 : LOCK_AT - remainder;
}

export function registerSessionRoutes(router: MockRouter, state: MockState): void {
  router.route('POST', '/api/m/v1/session/challenge', (ctx) => {
    const body = challengeBody.parse(ctx.body);
    const now = ctx.now();
    const challenge = randomId(24);
    state.challenges.set(challenge, {
      deviceId: body.device_id,
      purpose: body.purpose,
      actionId: body.action_id,
      expiresAt: now + CHALLENGE_TTL_MS,
      used: false,
    });
    return { status: 200, body: { challenge, expires_at: new Date(now + CHALLENGE_TTL_MS).toISOString() } };
  });

  router.route('POST', '/api/m/v1/session/token', (ctx) => {
    const body = tokenBody.parse(ctx.body);
    const now = ctx.now();
    const nowSeconds = Math.floor(now / 1000);

    // 1. The challenge: exists, unused, unexpired, bound to this device — consumed (single use)
    // the moment it passes, before anything else is checked.
    const chal = state.challenges.get(body.challenge);
    if (!chal || chal.used || now > chal.expiresAt || chal.deviceId !== body.device_id) {
      throw new WireError(401, 'CHALLENGE_INVALID', 'Desafio inválido ou expirado.');
    }
    chal.used = true;

    const device = state.devices.get(body.device_id);
    if (!device) throw new WireError(401, 'DEVICE_REVOKED', 'Este aparelho foi removido da conta.');

    // 2. The DPoP signature, against the device's stored key, carrying this exact challenge as
    // `chal` — before any PIN counting (P's Review Focus 1) and before the revoked check, so a
    // forged proof for a revoked device still answers PROOF_INVALID, not a status leak.
    const dpop = ctx.headers.dpop;
    const result = dpop
      ? verifyProof(dpop, { htm: 'POST', htu: ctx.htu, now: nowSeconds, jwk: device.jwk, chal: body.challenge })
      : undefined;
    if (!result || !result.ok) throw new WireError(401, 'PROOF_INVALID', 'Prova de posse inválida.');

    // 3. Replay window.
    if (!claimJti(state, device.id, result.jti, nowSeconds)) {
      throw new WireError(401, 'PROOF_REPLAYED', 'Prova repetida.');
    }

    // 4. Device status.
    if (device.status === 'revoked') throw new WireError(401, 'DEVICE_REVOKED', 'Este aparelho foi removido da conta.');

    // 5. Lock — blocks even a correct PIN while it holds, without counting another failure.
    if (device.lockedUntil !== undefined && device.lockedUntil > now) {
      const retryAfter = Math.ceil((device.lockedUntil - now) / 1000);
      throw new WireError(423, 'DEVICE_LOCKED', 'Aparelho bloqueado por tentativas de PIN.', { retry_after: retryAfter });
    }

    // 6. The PIN proof itself.
    const expected = pinProof(device.pinSecret, body.challenge);
    if (body.pin_proof !== expected) {
      device.pinFailures += 1;
      if (device.pinFailures >= REVOKE_AT) {
        revokeDevice(state, device, 'pin_bruteforce');
      } else if (device.pinFailures === LOCK_AT) {
        device.lockedUntil = now + LOCK_MS;
      }
      // The failure that (re)triggers a lock or the revoke still answers PIN_INVALID itself —
      // the next call is the one that sees 423 / DEVICE_REVOKED.
      throw new WireError(401, 'PIN_INVALID', 'PIN incorreto.', { attempts_left: attemptsLeft(device.pinFailures) });
    }

    device.pinFailures = 0;
    const accessToken = randomId(32);
    state.tokens.set(accessToken, { deviceId: device.id, expiresAt: now + ACCESS_TOKEN_TTL_MS });
    return { status: 200, body: { access_token: accessToken, expires_in: 900 } };
  });
}
