import { describe, expect, it } from 'vitest';
import { toPublicUser, type User } from './types.js';

const user: User = {
  id: 'u1', email: 'p@x.dev', name: 'Pedro', avatar_url: null, nickname: 'pedro', password_hash: 'hash', google_id: 'g1',
  role: 'member', role_id: null, invited_at: null, last_login_at: null, created_at: '2026-09-23T00:00:00.000Z',
  city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: 'https://77a.it/meu',
};

// /auth/me and the user lists are built from this: the short links are read through
// /auth/me/city-link (and the public city snapshot), never through the account payload.
describe('toPublicUser', () => {
  it('drops the secrets and the city short links', () => {
    const out = toPublicUser(user) as unknown as Record<string, unknown>;
    for (const k of ['password_hash', 'google_id', 'city_short_url_partner', 'city_short_url_custom']) expect(k in out).toBe(false);
    expect(out).toMatchObject({ id: 'u1', nickname: 'pedro', has_password: true, has_google: true });
  });
});
