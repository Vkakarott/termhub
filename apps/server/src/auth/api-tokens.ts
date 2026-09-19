import { createHash, randomBytes } from 'node:crypto';

/** Personal API tokens (Settings → Tokens de API), used by the MCP endpoint. Only the hash is stored. */
export const API_TOKEN_PREFIX = 'thb_pat_';
export const API_TOKEN_RE = /^thb_pat_[A-Za-z0-9_-]{43}$/;

/** What a token may do, on top of the owner's own grants (effective = scopes ∩ grants). */
export const API_TOKEN_SCOPES = ['read', 'tasks', 'terminals'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const MAX_ACTIVE_TOKENS_PER_USER = 20;
export const API_TOKEN_EVENT_RETENTION_DAYS = 30;

export function newApiToken(): { token: string; hash: string } {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashApiToken(token) };
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Known scopes only, once each, in catalog order. */
export function toScopes(raw: readonly string[]): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((s) => raw.includes(s));
}
