// Copied verbatim from packages/mobile-api/src/enrolment.test.ts @ c6bab0a (feat/mobile-chat-server), converted from
// vitest to jest globals. Replaced by tests in `@termhub/mobile-api` once that package is on main.
import { deviceRequestBody, devicePollResponse, formatVerificationCode, verificationCodeSchema } from './enrolment.js';

describe('enrolment contract', () => {
  it('accepts a well-formed request and normalises the e-mail', () => {
    const r = deviceRequestBody.parse({ email: '  Pedro@X.com ', public_key: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, device: { platform: 'ios', model: 'iPhone15,2', os_version: '18.1', name: 'iPhone de Pedro' }, app_version: '1.0.0+12' });
    expect(r.email).toBe('pedro@x.com');
  });
  it('refuses a non-EC key and a platform it does not know', () => {
    expect(() => deviceRequestBody.parse({ email: 'a@b.c', public_key: { kty: 'RSA' }, device: { platform: 'ios', model: 'x', os_version: '1', name: 'n' }, app_version: '1.0.0+1' })).toThrow();
    expect(() => deviceRequestBody.parse({ email: 'a@b.c', public_key: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, device: { platform: 'web', model: 'x', os_version: '1', name: 'n' }, app_version: '1.0.0+1' })).toThrow();
  });
  it('verification codes use only the unambiguous alphabet and format as XXX-XXX', () => {
    expect(verificationCodeSchema.safeParse('K7F2QD').success).toBe(true);
    expect(verificationCodeSchema.safeParse('K7F2Q0').success).toBe(false); // 0 is ambiguous
    expect(verificationCodeSchema.safeParse('K7F2QI').success).toBe(false); // I is ambiguous
    expect(formatVerificationCode('K7F2QD')).toBe('K7F-2QD');
  });
  it('poll status is a closed set', () => {
    expect(devicePollResponse.parse({ status: 'closed' })).toEqual({ status: 'closed' });
    expect(() => devicePollResponse.parse({ status: 'denied' })).toThrow();
  });
});
