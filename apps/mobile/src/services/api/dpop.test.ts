import { __items } from '../../../test/fakes/secure-store';
import { b64url, fromB64url, fromUtf8, utf8 } from '../crypto/encoding';
import { SoftwareDeviceKey } from '../key/software';
import type { P256Jwk } from '../key/types';
import { buildProof, verifyProof } from './dpop';

describe('DPoP proofs', () => {
  beforeEach(() => __items.clear());

  it('builds a proof the verifier accepts, and refuses a wrong htu, a stale iat, a wrong ath and a bad signature', async () => {
    const key = new SoftwareDeviceKey();
    const jwk = await key.create();
    const jws = await buildProof(key, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', iat: 1_000, ath: 'A', chal: 'C' });
    expect(jws.split('.')).toHaveLength(3);

    expect(
      verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', now: 1_030, jwk, ath: 'A', chal: 'C' }),
    ).toMatchObject({ ok: true, iat: 1_000 });

    expect(
      verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/challenge', now: 1_030, jwk, ath: 'A', chal: 'C' }),
    ).toEqual({ ok: false, reason: 'HTU' });

    expect(
      verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', now: 1_100, jwk, ath: 'A', chal: 'C' }),
    ).toEqual({ ok: false, reason: 'IAT' });

    expect(
      verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', now: 1_030, jwk, ath: 'B', chal: 'C' }),
    ).toEqual({ ok: false, reason: 'ATH' });

    // Two SoftwareDeviceKey instances share the vault key `key.private`; this one must use a
    // second vault slot so it holds a genuinely different key pair.
    const other = await new SoftwareDeviceKey('device.id').create();
    expect(
      verifyProof(jws, { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/session/token', now: 1_030, jwk: other, ath: 'A', chal: 'C' }),
    ).toEqual({ ok: false, reason: 'SIGNATURE' });
  });
});

describe('verifyProof edge cases', () => {
  beforeEach(() => __items.clear());

  const htm = 'POST';
  const htu = 'https://termhub.dev/api/m/v1/session/token';
  const iat = 1_000;
  const now = 1_010;
  const placeholderJwk: P256Jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };

  const makeProof = async () => {
    const key = new SoftwareDeviceKey();
    const jwk = await key.create();
    const jws = await buildProof(key, { htm, htu, iat });
    return { jwk, jws };
  };

  it('rejects a wrong htm', async () => {
    const { jwk, jws } = await makeProof();
    expect(verifyProof(jws, { htm: 'GET', htu, now, jwk })).toEqual({ ok: false, reason: 'HTM' });
  });

  it('rejects a payload tampered after signing (same htm/htu/iat, different jti), even with the correct jwk', async () => {
    const { jwk, jws } = await makeProof();
    const [h, p, s] = jws.split('.') as [string, string, string];
    const payloadObj = JSON.parse(fromUtf8(fromB64url(p))) as Record<string, unknown>;
    const tamperedPayload = b64url(utf8(JSON.stringify({ ...payloadObj, jti: 'tampered' })));

    expect(verifyProof(`${h}.${tamperedPayload}.${s}`, { htm, htu, now, jwk })).toEqual({ ok: false, reason: 'SIGNATURE' });
  });

  it('rejects a tampered signature, even with the correct jwk', async () => {
    const { jwk, jws } = await makeProof();
    const [h, p, s] = jws.split('.') as [string, string, string];
    const sigBytes = fromB64url(s);
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;

    expect(verifyProof(`${h}.${p}.${b64url(sigBytes)}`, { htm, htu, now, jwk })).toEqual({ ok: false, reason: 'SIGNATURE' });
  });

  it('rejects a non-64-byte signature without throwing', async () => {
    const { jwk, jws } = await makeProof();
    const [h, p] = jws.split('.') as [string, string, string];
    const shortSig = b64url(new Uint8Array(10));

    expect(() => verifyProof(`${h}.${p}.${shortSig}`, { htm, htu, now, jwk })).not.toThrow();
    expect(verifyProof(`${h}.${p}.${shortSig}`, { htm, htu, now, jwk })).toEqual({ ok: false, reason: 'SIGNATURE' });
  });

  it('rejects the wrong number of segments', () => {
    expect(verifyProof('a.b', { htm, htu, now, jwk: placeholderJwk })).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('rejects a header that JSON-parses to null', () => {
    const nullPart = b64url(utf8('null'));
    const payloadPart = b64url(utf8(JSON.stringify({ htm, htu, iat, jti: 'x' })));
    const sigPart = b64url(new Uint8Array(64));

    expect(verifyProof(`${nullPart}.${payloadPart}.${sigPart}`, { htm, htu, now, jwk: placeholderJwk })).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  it('rejects a payload that JSON-parses to null', () => {
    const headerPart = b64url(utf8(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: { x: 'x', y: 'y' } })));
    const nullPart = b64url(utf8('null'));
    const sigPart = b64url(new Uint8Array(64));

    expect(verifyProof(`${headerPart}.${nullPart}.${sigPart}`, { htm, htu, now, jwk: placeholderJwk })).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  it('rejects a header with the wrong typ or alg', () => {
    const badHeader = b64url(utf8(JSON.stringify({ typ: 'jwt', alg: 'ES256', jwk: { x: 'x', y: 'y' } })));
    const payloadPart = b64url(utf8(JSON.stringify({ htm, htu, iat, jti: 'x' })));
    const sigPart = b64url(new Uint8Array(64));

    expect(verifyProof(`${badHeader}.${payloadPart}.${sigPart}`, { htm, htu, now, jwk: placeholderJwk })).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  it('rejects an ath the caller does not expect (expected absent, payload carries one)', async () => {
    const key = new SoftwareDeviceKey();
    const jwk = await key.create();
    const jws = await buildProof(key, { htm, htu, iat, ath: 'A' });

    expect(verifyProof(jws, { htm, htu, now, jwk })).toEqual({ ok: false, reason: 'ATH' });
  });

  it('rejects a chal the caller does not expect (expected absent, payload carries one)', async () => {
    const key = new SoftwareDeviceKey();
    const jwk = await key.create();
    const jws = await buildProof(key, { htm, htu, iat, chal: 'C' });

    expect(verifyProof(jws, { htm, htu, now, jwk })).toEqual({ ok: false, reason: 'CHAL' });
  });
});
