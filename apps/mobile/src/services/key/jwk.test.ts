import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, utf8 } from '../crypto/encoding';
import { derToRaw, jwkFromUncompressed, jwkThumbprint, jwkToUncompressed } from './jwk';

describe('jwkFromUncompressed / jwkToUncompressed', () => {
  it('splits a 65-byte uncompressed point (0x04‖X‖Y) into x/y and back', () => {
    const point = new Uint8Array(65);
    point[0] = 0x04;
    point.set(new Uint8Array(32).fill(1), 1);
    point.set(new Uint8Array(32).fill(2), 33);

    const jwk = jwkFromUncompressed(point);
    expect(jwk).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: b64url(new Uint8Array(32).fill(1)),
      y: b64url(new Uint8Array(32).fill(2)),
    });
    expect(jwk.x).toHaveLength(43);
    expect(jwk.y).toHaveLength(43);
    expect(jwkToUncompressed(jwk)).toEqual(point);
  });
});

describe('jwkThumbprint', () => {
  it('is base64url(sha256(canonical JSON)), RFC 7638 §3.1 key order (crv, kty, x, y)', () => {
    const x = 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4';
    const y = '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM';
    const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x, y };

    const expected = b64url(sha256(utf8(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)));
    expect(jwkThumbprint(jwk)).toBe(expected);
  });
});

describe('derToRaw', () => {
  it('converts a DER signature with no leading-zero padding to raw r‖s', () => {
    const r = new Uint8Array(32).fill(0x11); // high bit clear, no DER padding needed
    const s = new Uint8Array(32).fill(0x22);
    const der = new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);

    expect(derToRaw(der)).toEqual(new Uint8Array([...r, ...s]));
  });

  it('strips the DER leading zero used to keep a high-bit integer non-negative', () => {
    const r = new Uint8Array(32).fill(0xaa); // high bit set: DER prepends 0x00
    const s = new Uint8Array(32).fill(0x22);
    const der = new Uint8Array([0x30, 0x45, 0x02, 0x21, 0x00, ...r, 0x02, 0x20, ...s]);

    const raw = derToRaw(der);
    expect(raw).toHaveLength(64);
    expect(raw).toEqual(new Uint8Array([...r, ...s]));
  });
});
