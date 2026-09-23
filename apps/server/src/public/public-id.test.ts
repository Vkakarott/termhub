import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_PUBLIC_ID_KEY } from '../../test/setup.js';
import { PUBLIC_ID_KEY_NAME, generatePublicIdKey, loadPublicIdKey, publicId, setPublicIdKey } from './public-id.js';

afterEach(() => setPublicIdKey(TEST_PUBLIC_ID_KEY));

describe('publicId', () => {
  // The whole contract: the same answer on every container, so a snapshot read from blue and a
  // frame sent from green join on the visitor's page. A change to the construction (algorithm,
  // input format, encoding or length) silently breaks every open page — this literal catches it.
  it('is pinned: a fixed key and a fixed id give this exact id', () => {
    setPublicIdKey(Buffer.alloc(32, 7));
    expect(publicId('project', 'p_0123456789abcdef')).toBe('XqnUzs9jCu74u3srI8PIlw');
    expect(publicId('tab', 'p_0123456789abcdef')).toBe('4J0a4CEJL6iCFAZB_TXMTC');
  });

  it('keeps the shape the routes and the frontend expect: 22 base64url characters', () => {
    expect(publicId('machine', 'm1')).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  // Spec §5: an HMAC with a server secret, not a bare hash — whoever holds a real id cannot compute
  // its public id and confirm whether (and in whose city) that project is published.
  it('is keyed: knowing the real id is not enough to compute it', () => {
    const bare = createHash('sha256').update('project:p1').digest('base64url').slice(0, 22);
    expect(publicId('project', 'p1')).not.toBe(bare);
    const a = publicId('project', 'p1');
    setPublicIdKey(Buffer.alloc(32, 1));
    expect(publicId('project', 'p1')).not.toBe(a);
  });

  it('refuses to answer before a key was loaded, instead of minting ids nobody else agrees on', () => {
    setPublicIdKey(null);
    expect(() => publicId('project', 'p1')).toThrow(/key/);
  });
});

describe('loadPublicIdKey', () => {
  it('reads the instance secret, creating a 32-byte key when there is none', async () => {
    let stored: string | undefined;
    const repos = {
      instanceSecrets: {
        ensure: async (name: string, generate: () => string) => {
          expect(name).toBe(PUBLIC_ID_KEY_NAME);
          stored ??= generate();
          return stored;
        },
      },
    };
    const first = await loadPublicIdKey(repos as never);
    const second = await loadPublicIdKey(repos as never);
    expect(first.length).toBe(32);
    expect(second.equals(first)).toBe(true);
    expect(Buffer.from(generatePublicIdKey(), 'base64').length).toBe(32);
  });
});
