// P-256 JWK helpers: point <-> JWK conversion, RFC 7638 thumbprints and DER -> raw ECDSA
// signature conversion (needed for the hardware key, which returns DER; @noble/curves works
// in raw r‖s).
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, fromB64url, utf8 } from '../crypto/encoding';
import type { P256Jwk } from './types';

/** Splits a 65-byte uncompressed point (`0x04‖X‖Y`) into a P-256 JWK. */
export const jwkFromUncompressed = (point: Uint8Array): P256Jwk => {
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('INVALID_UNCOMPRESSED_POINT');
  return { kty: 'EC', crv: 'P-256', x: b64url(point.slice(1, 33)), y: b64url(point.slice(33, 65)) };
};

/** Rebuilds the 65-byte uncompressed point (`0x04‖X‖Y`) from a P-256 JWK. */
export const jwkToUncompressed = (jwk: P256Jwk): Uint8Array => {
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(fromB64url(jwk.x), 1);
  out.set(fromB64url(jwk.y), 33);
  return out;
};

/** RFC 7638 thumbprint: base64url(sha256(canonical JSON)), keys in lexicographic order. */
export const jwkThumbprint = (jwk: P256Jwk): string => {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(sha256(utf8(canonical)));
};

/** Strips DER's leading zero (added to keep an integer's sign bit non-negative), if any, and left-pads to 32 bytes. */
const derIntTo32 = (bytes: Uint8Array): Uint8Array => {
  let b = bytes;
  while (b.length > 32 && b[0] === 0) b = b.slice(1);
  if (b.length > 32) throw new Error('INVALID_DER');
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
};

/** Converts an ECDSA DER signature (`30 len 02 rLen r 02 sLen s`) to raw `r‖s` (64 bytes). */
export const derToRaw = (der: Uint8Array): Uint8Array => {
  if (der[0] !== 0x30) throw new Error('INVALID_DER');
  let pos = 2; // skip the SEQUENCE tag and its (single-byte) length
  if (der[pos++] !== 0x02) throw new Error('INVALID_DER');
  const rLen = der[pos++];
  if (rLen === undefined) throw new Error('INVALID_DER');
  const r = der.slice(pos, pos + rLen);
  pos += rLen;
  if (der[pos++] !== 0x02) throw new Error('INVALID_DER');
  const sLen = der[pos++];
  if (sLen === undefined) throw new Error('INVALID_DER');
  const s = der.slice(pos, pos + sLen);

  const out = new Uint8Array(64);
  out.set(derIntTo32(r), 0);
  out.set(derIntTo32(s), 32);
  return out;
};
