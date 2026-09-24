import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { JWK, JWTPayload } from 'jose';

// DPoP-style proof verification for the mobile API. Every request carries a compact JWS
// (ES256, typ dpop+jwt, the device's public JWK in the header) signed by a non-exportable
// key on the phone. Never log a proof or a token.

export interface ProofCheck {
  proof: string;
  htm: string;
  htu: string;
  publicKeyJwk: JsonWebKey;
  accessToken?: string;
  extra?: Record<string, string>;
  now?: Date;
}

export type ProofResult =
  | { ok: true; jti: string; jwkThumbprint: string }
  | {
      ok: false;
      code:
        | 'PROOF_MISSING'
        | 'PROOF_INVALID'
        | 'PROOF_KEY_MISMATCH'
        | 'PROOF_METHOD'
        | 'PROOF_URL'
        | 'PROOF_STALE'
        | 'PROOF_TOKEN'
        | 'PROOF_CLAIM';
    };

export const SKEW_MS = 60_000;

export async function thumbprint(jwk: JsonWebKey): Promise<string> {
  return calculateJwkThumbprint(jwk as JWK, 'sha256');
}

export async function verifyProof(c: ProofCheck): Promise<ProofResult> {
  if (!c.proof) return { ok: false, code: 'PROOF_MISSING' };
  let header;
  try {
    header = decodeProtectedHeader(c.proof);
  } catch {
    return { ok: false, code: 'PROOF_INVALID' };
  }
  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) return { ok: false, code: 'PROOF_INVALID' };
  // The header's jwk is compared, never trusted: the signature is checked against the STORED key.
  let stored: string;
  let presented: string;
  try {
    stored = await thumbprint(c.publicKeyJwk);
    presented = await thumbprint(header.jwk as JsonWebKey);
  } catch {
    return { ok: false, code: 'PROOF_INVALID' };
  }
  if (presented !== stored) return { ok: false, code: 'PROOF_KEY_MISMATCH' };
  let payload: JWTPayload;
  try {
    const key = await importJWK(c.publicKeyJwk as JWK, 'ES256');
    ({ payload } = await jwtVerify(c.proof, key, { algorithms: ['ES256'], typ: 'dpop+jwt', clockTolerance: 0 }));
  } catch {
    return { ok: false, code: 'PROOF_INVALID' };
  }
  if (payload.htm !== c.htm) return { ok: false, code: 'PROOF_METHOD' };
  if (payload.htu !== c.htu) return { ok: false, code: 'PROOF_URL' };
  // jwtVerify only checks iat for maxTokenAge; the symmetric ±60 s window is ours.
  const now = (c.now ?? new Date()).getTime();
  if (typeof payload.iat !== 'number' || Math.abs(payload.iat * 1000 - now) > SKEW_MS) {
    return { ok: false, code: 'PROOF_STALE' };
  }
  if (typeof payload.jti !== 'string' || payload.jti.length < 8 || payload.jti.length > 128) {
    return { ok: false, code: 'PROOF_INVALID' };
  }
  if (c.accessToken !== undefined) {
    const ath = createHash('sha256').update(c.accessToken).digest('base64url');
    if (payload.ath !== ath) return { ok: false, code: 'PROOF_TOKEN' };
  }
  for (const [k, v] of Object.entries(c.extra ?? {})) if (payload[k] !== v) return { ok: false, code: 'PROOF_CLAIM' };
  return { ok: true, jti: payload.jti, jwkThumbprint: stored };
}

/** Replay cache for proof jtis, scoped per device (or any other scope string). */
export class JtiCache {
  private readonly seen = new Map<string, number>(); // `${scope}:${jti}` -> expiry (ms)

  constructor(private readonly windowMs = 5 * 60_000) {}

  /** Returns false when this jti was already claimed in this scope inside the window. */
  claim(scope: string, jti: string, now = Date.now()): boolean {
    if (this.seen.size > 1000) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    }
    const key = `${scope}:${jti}`;
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > now) return false;
    this.seen.set(key, now + this.windowMs);
    return true;
  }

  size(): number {
    return this.seen.size;
  }
}
