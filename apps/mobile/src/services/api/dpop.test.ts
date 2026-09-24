import { __items } from '../../../test/fakes/secure-store';
import { SoftwareDeviceKey } from '../key/software';
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
