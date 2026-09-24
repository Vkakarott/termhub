import { createHash } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, calculateJwkThumbprint } from 'jose';
import { describe, expect, it } from 'vitest';
import { JtiCache, verifyProof } from './dpop.js';

async function device() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const sign = (claims: Record<string, unknown>, jwkHeader = jwk) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: jwkHeader }).sign(privateKey);
  return { jwk, sign };
}
const base = { htm: 'POST', htu: 'https://termhub.dev/api/m/v1/chat/messages' };
const nowSec = () => Math.floor(Date.now() / 1000);
const athOf = (token: string) => createHash('sha256').update(token).digest('base64url');

describe('verifyProof', () => {
  it('accepts a fresh proof over the right method and url, and returns the jti and thumbprint', async () => {
    const d = await device();
    // The implementation requires 8..128 chars for jti, so the brief's 'j1' is lengthened.
    const jti = 'jti-0001';
    const proof = await d.sign({ ...base, iat: Math.floor(Date.now() / 1000), jti });
    const r = await verifyProof({ proof, ...base, publicKeyJwk: d.jwk });
    expect(r).toMatchObject({ ok: true, jti, jwkThumbprint: await calculateJwkThumbprint(d.jwk, 'sha256') });
  });

  it('binds the access token through ath', async () => {
    const d = await device();
    const proof = await d.sign({ ...base, iat: nowSec(), jti: 'jti-ath-1', ath: athOf('tok') });
    expect(await verifyProof({ proof, ...base, publicKeyJwk: d.jwk, accessToken: 'tok' })).toMatchObject({ ok: true });
    expect(await verifyProof({ proof, ...base, publicKeyJwk: d.jwk, accessToken: 'other' })).toEqual({
      ok: false,
      code: 'PROOF_TOKEN',
    });
    const noAth = await d.sign({ ...base, iat: nowSec(), jti: 'jti-ath-2' });
    expect(await verifyProof({ proof: noAth, ...base, publicKeyJwk: d.jwk, accessToken: 'tok' })).toEqual({
      ok: false,
      code: 'PROOF_TOKEN',
    });
  });

  it('rejects a proof signed by another key even if it carries the stored jwk in its header (PROOF_INVALID)', async () => {
    const a = await device();
    const b = await device();
    const proof = await b.sign({ ...base, iat: nowSec(), jti: 'jti-forged' }, a.jwk);
    expect(await verifyProof({ proof, ...base, publicKeyJwk: a.jwk })).toEqual({ ok: false, code: 'PROOF_INVALID' });
  });

  it('rejects a header jwk that is not the stored key (PROOF_KEY_MISMATCH)', async () => {
    const a = await device();
    const b = await device();
    const proof = await b.sign({ ...base, iat: nowSec(), jti: 'jti-mismatch' });
    expect(await verifyProof({ proof, ...base, publicKeyJwk: a.jwk })).toEqual({
      ok: false,
      code: 'PROOF_KEY_MISMATCH',
    });
  });

  it('rejects the wrong method (PROOF_METHOD), the wrong url or a url with a query (PROOF_URL)', async () => {
    const d = await device();
    const wrongMethod = await d.sign({ ...base, htm: 'GET', iat: nowSec(), jti: 'jti-method' });
    expect(await verifyProof({ proof: wrongMethod, ...base, publicKeyJwk: d.jwk })).toEqual({
      ok: false,
      code: 'PROOF_METHOD',
    });
    const wrongUrl = await d.sign({
      ...base,
      htu: 'https://termhub.dev/api/m/v1/chat/threads',
      iat: nowSec(),
      jti: 'jti-url-1',
    });
    expect(await verifyProof({ proof: wrongUrl, ...base, publicKeyJwk: d.jwk })).toEqual({
      ok: false,
      code: 'PROOF_URL',
    });
    const withQuery = await d.sign({ ...base, htu: `${base.htu}?x=1`, iat: nowSec(), jti: 'jti-url-2' });
    expect(await verifyProof({ proof: withQuery, ...base, publicKeyJwk: d.jwk })).toEqual({
      ok: false,
      code: 'PROOF_URL',
    });
  });

  it('rejects iat more than 60 s away in either direction (PROOF_STALE) and accepts 59 s', async () => {
    const d = await device();
    const now = new Date();
    const t = Math.floor(now.getTime() / 1000);
    const at = (iat: number, jti: string) => d.sign({ ...base, iat, jti });
    const check = async (iat: number, jti: string) =>
      verifyProof({ proof: await at(iat, jti), ...base, publicKeyJwk: d.jwk, now: new Date(t * 1000) });
    expect(await check(t - 61, 'jti-old-61')).toEqual({ ok: false, code: 'PROOF_STALE' });
    expect(await check(t + 61, 'jti-new-61')).toEqual({ ok: false, code: 'PROOF_STALE' });
    expect(await check(t - 59, 'jti-old-59')).toMatchObject({ ok: true });
    expect(await check(t + 59, 'jti-new-59')).toMatchObject({ ok: true });
  });

  it('checks an extra claim such as chal (PROOF_CLAIM)', async () => {
    const d = await device();
    const proof = await d.sign({ ...base, iat: nowSec(), jti: 'jti-chal-1', chal: 'c2' });
    expect(await verifyProof({ proof, ...base, publicKeyJwk: d.jwk, extra: { chal: 'c1' } })).toEqual({
      ok: false,
      code: 'PROOF_CLAIM',
    });
    expect(await verifyProof({ proof, ...base, publicKeyJwk: d.jwk, extra: { chal: 'c2' } })).toMatchObject({
      ok: true,
    });
  });

  it('rejects garbage and a missing proof (PROOF_INVALID / PROOF_MISSING)', async () => {
    const d = await device();
    expect(await verifyProof({ proof: '', ...base, publicKeyJwk: d.jwk })).toEqual({ ok: false, code: 'PROOF_MISSING' });
    expect(await verifyProof({ proof: 'not.a.jws', ...base, publicKeyJwk: d.jwk })).toEqual({
      ok: false,
      code: 'PROOF_INVALID',
    });
    expect(await verifyProof({ proof: 'garbage', ...base, publicKeyJwk: d.jwk })).toEqual({
      ok: false,
      code: 'PROOF_INVALID',
    });
  });

  it('rejects a jti that is too short (PROOF_INVALID)', async () => {
    const d = await device();
    const proof = await d.sign({ ...base, iat: nowSec(), jti: 'j1' });
    expect(await verifyProof({ proof, ...base, publicKeyJwk: d.jwk })).toEqual({ ok: false, code: 'PROOF_INVALID' });
  });

  it('rejects a malformed header jwk without throwing (PROOF_INVALID)', async () => {
    const d = await device();
    const proof = await d.sign({ ...base, iat: nowSec(), jti: 'jti-badjwk' }, { kty: 'EC' } as never);
    expect(await verifyProof({ proof, ...base, publicKeyJwk: d.jwk })).toEqual({ ok: false, code: 'PROOF_INVALID' });
  });
});

describe('JtiCache', () => {
  it('second use of a jti is rejected inside the window and accepted after it', () => {
    const c = new JtiCache(5 * 60_000);
    expect(c.claim('dev1', 'j')).toBe(true);
    expect(c.claim('dev1', 'j')).toBe(false);
    expect(c.claim('dev2', 'j')).toBe(true); // scoped per device
    expect(c.claim('dev1', 'j', Date.now() + 5 * 60_001)).toBe(true);
  });

  it('prunes expired entries once it holds more than 1000', () => {
    const c = new JtiCache(1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 1001; i++) c.claim('dev', `j${i}`, t0);
    expect(c.size()).toBe(1001);
    c.claim('dev', 'fresh', t0 + 2000);
    expect(c.size()).toBe(1);
  });
});
