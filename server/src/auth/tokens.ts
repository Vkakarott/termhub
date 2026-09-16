import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'termhub_session';
export const CSRF_COOKIE = 'termhub_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const OAUTH_COOKIE = 'termhub_oauth';

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Só o hash do token vai pro banco: vazamento do DB não dá acesso às sessões. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
