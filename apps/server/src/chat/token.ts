import { newApiToken, type ApiTokenScope } from '../auth/api-tokens.js';
import type { Repositories } from '../db/repositories/index.js';

/** Name of the token the server mints for the concierge. It is rotated on every run, so a leaked
 * one is useless within a day and the audit trail in api_token_events stays per-run. */
export const CONCIERGE_TOKEN_NAME = 'concierge (automático)';
const TTL_MS = 24 * 60 * 60 * 1000;

/** Mints a fresh token for the concierge and revokes the previous one. The plain token is returned
 * to the caller and stored nowhere — the runner receives it per request. */
export async function mintConciergeToken(repos: Repositories, userId: string, scopes: ApiTokenScope[]): Promise<string> {
  const previous = (await repos.apiTokens.listByUser(userId)).filter((t) => t.name === CONCIERGE_TOKEN_NAME && t.revoked_at === null);
  for (const t of previous) await repos.apiTokens.revoke(t.id, userId);

  const { token, hash } = newApiToken();
  // `gated: true` is hardcoded here, never taken from a caller — this is the one function that
  // mints the concierge's own token, so wide scopes and the gate flag can only ever arrive together.
  await repos.apiTokens.create(userId, { name: CONCIERGE_TOKEN_NAME, scopes, expiresAt: new Date(Date.now() + TTL_MS), gated: true }, hash);
  return token;
}
