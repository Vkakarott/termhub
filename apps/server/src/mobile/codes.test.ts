import { describe, expect, it } from 'vitest';
import { verificationCodeSchema } from '@termhub/mobile-api';
import {
  MOBILE_TOKEN_RE,
  REQUEST_SECRET_RE,
  hashEmail,
  newChallenge,
  newMobileToken,
  newPinSecret,
  newRequestSecret,
  newVerificationCode,
  pinProofFor,
} from './codes.js';

describe('newVerificationCode', () => {
  it('generates 1000 codes that all match the shared schema and never use ambiguous characters', () => {
    for (let i = 0; i < 1000; i++) {
      const code = newVerificationCode();
      expect(verificationCodeSchema.safeParse(code).success).toBe(true);
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });
});

describe('hashEmail', () => {
  it('is a stable 64-char hex digest', () => {
    const a = hashEmail('a@b.c');
    const b = hashEmail('a@b.c');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
});

describe('newMobileToken / newRequestSecret / newChallenge / newPinSecret', () => {
  it('newMobileToken matches MOBILE_TOKEN_RE', () => {
    expect(newMobileToken()).toMatch(MOBILE_TOKEN_RE);
  });

  it('newRequestSecret matches REQUEST_SECRET_RE', () => {
    expect(newRequestSecret()).toMatch(REQUEST_SECRET_RE);
  });

  it('newChallenge and newPinSecret are base64url of 32 random bytes', () => {
    const challenge = newChallenge();
    const pinSecret = newPinSecret();
    // base64url of 32 bytes is 43 chars, no padding.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pinSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newChallenge()).not.toBe(challenge);
    expect(newPinSecret()).not.toBe(pinSecret);
  });
});

describe('pinProofFor', () => {
  it('is deterministic for the same secret and message', () => {
    const secret = newPinSecret();
    expect(pinProofFor(secret, 'x')).toBe(pinProofFor(secret, 'x'));
  });

  it('differs for a different secret', () => {
    const secretA = newPinSecret();
    const secretB = newPinSecret();
    expect(pinProofFor(secretA, 'x')).not.toBe(pinProofFor(secretB, 'x'));
  });

  it('is base64url: no padding, no + or /', () => {
    const secret = newPinSecret();
    const proof = pinProofFor(secret, 'x');
    expect(proof).not.toMatch(/[=+/]/);
    expect(proof).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
