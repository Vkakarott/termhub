import type { AiCredential, AiProviderAdapter, AiUsageResult } from './types.js';
import { isObj, num, str } from './credentials.js';
import { fetchCodeAssistUsage } from './code-assist.js';

/**
 * Gemini (Google account: free tier / Google AI Pro / Ultra via Gemini Code Assist).
 * Credential: Gemini CLI login — ~/.gemini/oauth_creds.json. Quota comes from the
 * Code Assist endpoints the CLI itself uses for /stats. Best effort: undocumented.
 */
export const geminiAdapter: AiProviderAdapter = {
  provider: 'gemini',
  loginHint: 'Run `gemini` on that machine and sign in with Google (API-key logins have no quota to show).',

  credentialScript() {
    return `if [ -f "$D/oauth_creds.json" ]; then cat "$D/oauth_creds.json"; fi`;
  },

  parseCredential(stdout) {
    const json = JSON.parse(stdout) as unknown;
    const token = isObj(json) ? str(json.access_token) : null;
    if (!token) throw new Error('Gemini CLI credential has no access token');
    return { token, extra: {}, expires_at: isObj(json) ? num(json.expiry_date) : null, plan: null };
  },

  fetchUsage(cred: AiCredential): Promise<AiUsageResult> {
    return fetchCodeAssistUsage(cred, {
      expired: 'Run `gemini` on that machine once; it refreshes the token on use.',
      refresh: 'Run `gemini` on that machine once to refresh the login.',
      ide: 'gemini',
    });
  },
};
