import { describe, expect, it } from 'vitest';
import { antigravityAdapter } from './antigravity.js';

describe('antigravityAdapter.parseCredential', () => {
  it('returns the token and expires_at for the documented credential shape', () => {
    const stdout = JSON.stringify({ token: { access_token: 'ya29.test', expiry: '2026-09-18T12:00:00Z' } });
    const cred = antigravityAdapter.parseCredential(stdout);
    expect(cred.token).toBe('ya29.test');
    expect(cred.expires_at).toBe(Date.parse('2026-09-18T12:00:00Z'));
    expect(cred.extra).toEqual({});
    expect(cred.plan).toBeNull();
  });

  it('throws when token.access_token is missing', () => {
    const stdout = JSON.stringify({ token: { expiry: '2026-09-18T12:00:00Z' } });
    expect(() => antigravityAdapter.parseCredential(stdout)).toThrow('Antigravity CLI credential has no access token');
  });

  it('expires_at is null when expiry is absent', () => {
    const stdout = JSON.stringify({ token: { access_token: 'ya29.test' } });
    const cred = antigravityAdapter.parseCredential(stdout);
    expect(cred.expires_at).toBeNull();
  });

  it('expires_at is null when expiry is not a parsable date', () => {
    const stdout = JSON.stringify({ token: { access_token: 'ya29.test', expiry: 'not-a-date' } });
    const cred = antigravityAdapter.parseCredential(stdout);
    expect(cred.expires_at).toBeNull();
  });
});

describe('antigravityAdapter.credentialScript', () => {
  it('mentions the antigravity-cli oauth token file', () => {
    expect(antigravityAdapter.credentialScript(null)).toContain('antigravity-cli/antigravity-oauth-token');
  });
});
