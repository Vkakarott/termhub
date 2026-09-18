import { credentialScript } from '@termhub/machine-ops';
import type { AiCredential, AiProviderAdapter, AiUsageResult } from './types.js';
import { isObj, str } from './credentials.js';
import { fetchCodeAssistUsage } from './code-assist.js';

/**
 * Antigravity CLI (`agy`) — Google's successor to the consumer Gemini CLI.
 * Credential: ~/.gemini/antigravity-cli/antigravity-oauth-token. It authenticates
 * the same Google account against the same Code Assist endpoints as Gemini.
 */
export const antigravityAdapter: AiProviderAdapter = {
  provider: 'antigravity',
  loginHint: 'Run `agy` on that machine and sign in with Google (API-key logins have no quota to show).',

  credentialScript() {
    return credentialScript('antigravity');
  },

  parseCredential(stdout) {
    const json = JSON.parse(stdout) as unknown;
    const tokenObj = isObj(json) && isObj(json.token) ? json.token : null;
    const token = tokenObj ? str(tokenObj.access_token) : null;
    if (!token) throw new Error('Antigravity CLI credential has no access token');
    const expiry = tokenObj ? str(tokenObj.expiry) : null;
    const parsed = expiry ? Date.parse(expiry) : NaN;
    return { token, extra: {}, expires_at: Number.isNaN(parsed) ? null : parsed, plan: null };
  },

  fetchUsage(cred: AiCredential): Promise<AiUsageResult> {
    return fetchCodeAssistUsage(cred, {
      expired: 'Run `agy` on that machine once; it refreshes the token on use.',
      refresh: 'Run `agy` on that machine once to refresh the login.',
      ide: 'antigravity',
    });
  },
};
