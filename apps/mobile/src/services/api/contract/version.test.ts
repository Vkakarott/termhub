// Copied verbatim from packages/mobile-api/src/version.test.ts @ c6bab0a (feat/mobile-chat-server), converted from
// vitest to jest globals. Replaced by tests in `@termhub/mobile-api` once that package is on main.
import { compareVersions, parseAppHeader } from './version.js';

describe('app version header', () => {
  it('parses ios/1.2.0+34', () => expect(parseAppHeader('ios/1.2.0+34')).toEqual({ platform: 'ios', version: '1.2.0', build: 34 }));
  it('rejects garbage', () => { expect(parseAppHeader('curl/8')).toBeNull(); expect(parseAppHeader(undefined)).toBeNull(); });
  it('compares numerically, not lexically', () => { expect(compareVersions('1.10.0', '1.9.0')).toBe(1); expect(compareVersions('1.0.0', '1.0.0')).toBe(0); expect(compareVersions('0.9.9', '1.0.0')).toBe(-1); });
});
