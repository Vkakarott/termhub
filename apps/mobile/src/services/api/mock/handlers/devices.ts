// Enrolment routes (P§4, design spec §4.2): `devices/requests`, `devices/requests/:id`,
// `devices/activate`.
import { b64url } from '../../../crypto/encoding';
import { randomBytes, randomId } from '../../../crypto/random';
import { deviceActivateBody, deviceRequestBody, VERIFICATION_CODE_ALPHABET } from '../../contract';
import { verifyProof } from '../../dpop';
import type { MockRouter } from '../router';
import { bearerToken, requestStatus, sha256Hex, WireError, type MockState } from '../state';

const REQUEST_TTL_MS = 10 * 60_000;
const ACTIVATE_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_TTL_MS = 15 * 60_000;

/** 6 characters from the contract's ambiguity-free alphabet, drawn with `randomBytes` (ruling 8) —
 * never `Math.random`. */
function generateVerificationCode(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += VERIFICATION_CODE_ALPHABET[b % VERIFICATION_CODE_ALPHABET.length];
  return out;
}

export function registerDeviceRoutes(router: MockRouter, state: MockState): void {
  // Always 202, same shape for any e-mail (P§4.2): the mock does not model decoys (no server-side
  // account to check against), but every request becomes a row exactly the same way regardless.
  router.route('POST', '/api/m/v1/devices/requests', (ctx) => {
    const body = deviceRequestBody.parse(ctx.body);
    const now = ctx.now();
    const id = randomId(12);
    const secret = randomId(24);
    const code = generateVerificationCode();

    state.requests.set(id, {
      id,
      email: body.email,
      publicKey: body.public_key,
      device: body.device,
      appVersion: body.app_version,
      secretHash: sha256Hex(secret),
      code,
      status: 'pending',
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
    });

    return {
      status: 202,
      body: {
        request_id: id,
        request_secret: secret,
        verification_code: code,
        expires_at: new Date(now + REQUEST_TTL_MS).toISOString(),
        poll_after: 2000,
      },
    };
  });

  // Bearer must equal the request secret; a wrong secret, an unknown id and every non-pending,
  // non-approved-inside-window status all answer the same `closed` (P§4.5 — no leak either way).
  router.route('GET', '/api/m/v1/devices/requests/:id', (ctx) => {
    const req = state.requests.get(ctx.params.id!);
    const bearer = bearerToken(ctx.headers);
    if (!req || !bearer || sha256Hex(bearer) !== req.secretHash) {
      return { status: 200, body: { status: 'closed' } };
    }
    return { status: 200, body: { status: requestStatus(req, ctx.now()) } };
  });

  // DPoP required (no `ath`, no access token yet): a bad signature is `401 PROOF_INVALID` before
  // the secret or the request's status are even looked at.
  router.route('POST', '/api/m/v1/devices/activate', (ctx) => {
    const body = deviceActivateBody.parse(ctx.body);
    const now = ctx.now();
    const req = state.requests.get(body.request_id);
    if (!req) throw new WireError(401, 'REQUEST_INVALID', 'Pedido inválido ou expirado.');

    const dpop = ctx.headers.dpop;
    const result = dpop
      ? verifyProof(dpop, { htm: 'POST', htu: ctx.htu, now: Math.floor(now / 1000), jwk: req.publicKey })
      : undefined;
    if (!result || !result.ok) throw new WireError(401, 'PROOF_INVALID', 'Prova de posse inválida.');

    if (sha256Hex(body.request_secret) !== req.secretHash) {
      throw new WireError(401, 'REQUEST_INVALID', 'Pedido inválido ou expirado.');
    }
    if (req.status !== 'approved' || req.activateUntil === undefined || now > req.activateUntil) {
      throw new WireError(401, 'REQUEST_INVALID', 'Pedido inválido ou expirado.');
    }

    const deviceId = randomId(12);
    const pinSecret = randomBytes(32);
    const accessToken = randomId(32);

    state.devices.set(deviceId, {
      id: deviceId,
      userId: 'u1',
      email: req.email,
      jwk: req.publicKey,
      pinSecret,
      pinFailures: 0,
      status: 'active',
      name: req.device.name,
      platform: req.device.platform,
      model: req.device.model,
      os: req.device.os_version,
      createdAt: now,
    });
    state.tokens.set(accessToken, { deviceId, expiresAt: now + ACCESS_TOKEN_TTL_MS });
    req.status = 'activated';

    return {
      status: 200,
      body: { device_id: deviceId, pin_secret: b64url(pinSecret), access_token: accessToken, expires_in: 900 },
    };
  });
}

export { ACTIVATE_TTL_MS };
