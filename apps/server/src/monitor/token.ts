import { createHash, randomBytes } from 'node:crypto';

export const HOOK_TOKEN_PREFIX = 'thb_hk_';

/** New hook token for a machine: only its hash is stored; the plain token goes to the machine once. */
export function newHookToken(): { token: string; hash: string } {
  const token = HOOK_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashHookToken(token) };
}

export function hashHookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
