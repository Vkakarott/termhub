import { createHash, randomBytes } from 'node:crypto';

export const AGENT_TOKEN_RE = /^thb_ag_[A-Za-z0-9_-]{43}$/;
export const hashAgentToken = (token: string): string => createHash('sha256').update(token).digest('hex');
/** 256-bit random token; only the hash is stored. */
export function newAgentToken(): { token: string; hash: string } {
  const token = `thb_ag_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashAgentToken(token) };
}
