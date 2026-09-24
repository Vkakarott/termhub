import { p256 } from '@noble/curves/nist.js';
import { __items } from '../../../test/fakes/secure-store';
import { fromB64url, utf8 } from '../crypto/encoding';
import { jwkToUncompressed } from './jwk';
import { SoftwareDeviceKey } from './software';

describe('SoftwareDeviceKey', () => {
  beforeEach(() => __items.clear());

  it('creates a P-256 key and returns its public JWK', async () => {
    const key = new SoftwareDeviceKey();
    const jwk = await key.create();
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(jwk.x).toHaveLength(43);
    expect(jwk.y).toHaveLength(43);
  });

  it('exists() is false before create() and true after', async () => {
    const key = new SoftwareDeviceKey();
    expect(await key.exists()).toBe(false);
    await key.create();
    expect(await key.exists()).toBe(true);
  });

  it('sign() returns a 64-byte raw signature that verifies against the public JWK', async () => {
    const key = new SoftwareDeviceKey();
    const jwk = await key.create();
    const message = utf8('m');

    const sig = await key.sign(message);
    expect(sig).toHaveLength(64);
    expect(p256.verify(sig, message, jwkToUncompressed(jwk), { prehash: true })).toBe(true);
  });

  it('destroy() removes the key: exists() turns false and sign() rejects', async () => {
    const key = new SoftwareDeviceKey();
    await key.create();

    await key.destroy();

    expect(await key.exists()).toBe(false);
    await expect(key.sign(utf8('m'))).rejects.toThrow();
  });

  it('keeps the private key in the vault as base64url of 32 bytes under key.private, surviving a new instance', async () => {
    const key = new SoftwareDeviceKey();
    const jwk = await key.create();

    const stored = __items.get('key.private');
    expect(stored).toBeDefined();
    expect(fromB64url(stored as string)).toHaveLength(32);

    const second = new SoftwareDeviceKey();
    expect(await second.exists()).toBe(true);
    expect(await second.publicJwk()).toEqual(jwk);
  });
});
