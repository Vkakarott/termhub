import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { VERIFICATION_CODE_ALPHABET } from '@termhub/mobile-api';

const VERIFICATION_CODE_LENGTH = 6;

/** 6-char code read aloud from one screen and typed into another; no ambiguous characters. */
export function newVerificationCode(): string {
  let code = '';
  for (let i = 0; i < VERIFICATION_CODE_LENGTH; i++) {
    code += VERIFICATION_CODE_ALPHABET[randomInt(VERIFICATION_CODE_ALPHABET.length)];
  }
  return code;
}

/** sha256 hex of the normalised e-mail; used to look up pending enrolments without storing the address in plain. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export const MOBILE_TOKEN_PREFIX = 'thb_mob_';
export const REQUEST_SECRET_PREFIX = 'thb_req_';
export const MOBILE_TOKEN_RE = /^thb_mob_[A-Za-z0-9_-]{43}$/;
export const REQUEST_SECRET_RE = /^thb_req_[A-Za-z0-9_-]{43}$/;

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function newMobileToken(): string {
  return randomToken(MOBILE_TOKEN_PREFIX);
}

export function newRequestSecret(): string {
  return randomToken(REQUEST_SECRET_PREFIX);
}

/** Unprefixed 32 random bytes, base64url. */
export function newChallenge(): string {
  return randomBytes(32).toString('base64url');
}

/** 32 random bytes, base64url. The only secret ever returned to the app in plain. */
export function newPinSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** base64url(HMAC-SHA256(base64url-decoded secret, message)) — the proof the app derives from its PIN-unlocked secret. */
export function pinProofFor(pinSecret: string, message: string): string {
  return createHmac('sha256', Buffer.from(pinSecret, 'base64url')).update(message).digest('base64url');
}
