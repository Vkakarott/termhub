// DPoP proof of possession (P§5.2, design spec §2 "Proof of possession"). `buildProof` signs
// one with the device key; `verifyProof` is used by the mock transport to check one exactly as
// the real server would, so a wrong `htu`/`ath` or a stale `iat` fails locally, not only on the
// server.
import { p256 } from '@noble/curves/nist.js';
import { b64url, fromB64url, fromUtf8, utf8 } from '../crypto/encoding';
import { randomId } from '../crypto/random';
import { jwkToUncompressed } from '../key/jwk';
import type { DeviceKey, P256Jwk } from '../key/types';

type ProofInput = { htm: string; htu: string; iat: number; ath?: string; chal?: string };

/** Builds a compact DPoP JWS: header `{ typ, alg, jwk }`, payload `{ htm, htu, iat, jti, ath?, chal? }`. */
export const buildProof = async (key: DeviceKey, input: ProofInput): Promise<string> => {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: await key.publicJwk() };
  const payload = {
    htm: input.htm,
    htu: input.htu,
    iat: input.iat,
    jti: randomId(),
    ...(input.ath !== undefined && { ath: input.ath }),
    ...(input.chal !== undefined && { chal: input.chal }),
  };
  const signingInput = `${b64url(utf8(JSON.stringify(header)))}.${b64url(utf8(JSON.stringify(payload)))}`;
  const sig = await key.sign(utf8(signingInput));
  return `${signingInput}.${b64url(sig)}`;
};

type VerifyExpected = { htm: string; htu: string; now: number; skewSeconds?: number; jwk: P256Jwk; ath?: string; chal?: string };
type VerifyResult =
  | { ok: true; jti: string; iat: number }
  | { ok: false; reason: 'SIGNATURE' | 'HTM' | 'HTU' | 'IAT' | 'ATH' | 'CHAL' | 'MALFORMED' };

type ParsedHeader = { typ?: unknown; alg?: unknown; jwk?: { x?: unknown; y?: unknown } };
type ParsedPayload = { htm?: unknown; htu?: unknown; iat?: unknown; jti?: unknown; ath?: unknown; chal?: unknown };

/**
 * Verifies a compact DPoP JWS against the caller-supplied `jwk` — never the one in the JWS
 * header, which is untrusted input (P§5.2): the header's `jwk` is only compared for equality
 * of `x`/`y` against the caller's, and reported as `SIGNATURE` when it differs.
 */
export const verifyProof = (jws: string, expected: VerifyExpected): VerifyResult => {
  const parts = jws.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };
  const [headerPart, payloadPart, sigPart] = parts;
  if (headerPart === undefined || payloadPart === undefined || sigPart === undefined) {
    return { ok: false, reason: 'MALFORMED' };
  }

  let header: ParsedHeader;
  let payload: ParsedPayload;
  try {
    header = JSON.parse(fromUtf8(fromB64url(headerPart)));
    payload = JSON.parse(fromUtf8(fromB64url(payloadPart)));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (
    header.typ !== 'dpop+jwt' ||
    header.alg !== 'ES256' ||
    typeof header.jwk?.x !== 'string' ||
    typeof header.jwk?.y !== 'string' ||
    typeof payload.htm !== 'string' ||
    typeof payload.htu !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.jti !== 'string' ||
    (payload.ath !== undefined && typeof payload.ath !== 'string') ||
    (payload.chal !== undefined && typeof payload.chal !== 'string')
  ) {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (payload.htm !== expected.htm) return { ok: false, reason: 'HTM' };
  if (payload.htu !== expected.htu) return { ok: false, reason: 'HTU' };

  const skew = expected.skewSeconds ?? 60;
  if (Math.abs(payload.iat - expected.now) > skew) return { ok: false, reason: 'IAT' };

  if (expected.ath !== undefined ? payload.ath !== expected.ath : payload.ath !== undefined) {
    return { ok: false, reason: 'ATH' };
  }
  if (expected.chal !== undefined ? payload.chal !== expected.chal : payload.chal !== undefined) {
    return { ok: false, reason: 'CHAL' };
  }

  // The header's jwk is never trusted as the verification key; it is only checked for equality
  // against the caller's. A mismatch here is cryptographically equivalent to a bad signature.
  if (header.jwk.x !== expected.jwk.x || header.jwk.y !== expected.jwk.y) {
    return { ok: false, reason: 'SIGNATURE' };
  }

  let sig: Uint8Array;
  try {
    sig = fromB64url(sigPart);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  const signingInput = utf8(`${headerPart}.${payloadPart}`);
  const valid = p256.verify(sig, signingInput, jwkToUncompressed(expected.jwk), { prehash: true });
  if (!valid) return { ok: false, reason: 'SIGNATURE' };

  return { ok: true, jti: payload.jti, iat: payload.iat };
};
