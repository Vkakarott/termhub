import type { AiCredential, AiProviderAdapter, AiUsageResult, AiUsageWindow } from './types.js';
import { httpJson, isObj, num, str, toIso } from './credentials.js';

/**
 * Claude (claude.ai subscription: Pro / Max / Team / Enterprise seat).
 * Credential: Claude Code login — ~/.claude/.credentials.json (Linux) or the
 * "Claude Code-credentials" keychain item (macOS). Usage comes from the same
 * endpoint Claude Code's /usage uses.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 horas',
  seven_day: '7 dias',
  seven_day_opus: '7 dias · Opus',
  seven_day_sonnet: '7 dias · Sonnet',
  seven_day_oauth_apps: '7 dias · apps',
};

const GROUP_LABELS: Record<string, string> = { session: '5 horas', weekly: '7 dias' };

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/**
 * Turns the usage payload into windows. Top-level keys (five_hour, seven_day, ...) carry the
 * account-wide limits; per-model caps (e.g. the weekly Fable allowance) only show up in `limits[]`
 * as entries with a `scope`, so those are appended after the account-wide ones.
 */
export function parseUsageBody(body: Record<string, unknown>): AiUsageWindow[] {
  const windows: AiUsageWindow[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (!isObj(val)) continue;
    const utilization = num(val.utilization);
    if (utilization === null) continue;
    windows.push({ key, label: WINDOW_LABELS[key] ?? key.replace(/_/g, ' '), utilization: clamp(utilization), resets_at: toIso(val.resets_at) });
  }
  // known windows first, in a stable order
  const order = Object.keys(WINDOW_LABELS);
  windows.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));

  if (Array.isArray(body.limits)) {
    for (const lim of body.limits) {
      if (!isObj(lim) || !isObj(lim.scope)) continue;
      const percent = num(lim.percent);
      if (percent === null) continue;
      const model = isObj(lim.scope.model) ? str(lim.scope.model.display_name) : null;
      const surface = isObj(lim.scope.surface) ? str(lim.scope.surface.display_name) : str(lim.scope.surface);
      const scope = model ?? surface;
      if (!scope) continue;
      const group = str(lim.group) ?? str(lim.kind) ?? 'limit';
      windows.push({
        key: `limit:${str(lim.kind) ?? group}:${scope}`,
        label: `${GROUP_LABELS[group] ?? group.replace(/_/g, ' ')} · ${scope}`,
        utilization: clamp(percent),
        resets_at: toIso(lim.resets_at),
      });
    }
  }
  return windows;
}

export const claudeAdapter: AiProviderAdapter = {
  provider: 'claude',
  loginHint: 'Run `claude` on that machine and sign in (or set the config dir if you use CLAUDE_CONFIG_DIR).',

  credentialScript() {
    // file first (Linux, and macOS when keychain is disabled); then the macOS keychain
    return [
      `if [ -f "$D/.credentials.json" ]; then cat "$D/.credentials.json"`,
      `elif [ "$(uname -s)" = Darwin ]; then security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true`,
      `fi`,
    ].join('; ');
  },

  parseCredential(stdout) {
    const json = JSON.parse(stdout) as unknown;
    const oauth = isObj(json) && isObj(json.claudeAiOauth) ? json.claudeAiOauth : null;
    const token = oauth ? str(oauth.accessToken) : null;
    if (!token) throw new Error('Claude Code credential has no OAuth token');
    return {
      token,
      extra: {},
      expires_at: oauth ? num(oauth.expiresAt) : null,
      plan: oauth ? str(oauth.subscriptionType) : null,
    };
  },

  async fetchUsage(cred: AiCredential): Promise<AiUsageResult> {
    const base: AiUsageResult = { ok: false, plan: cred.plan, windows: [], error: null, hint: null };
    if (cred.expires_at && cred.expires_at < Date.now()) {
      return { ...base, error: 'Claude Code token expired', hint: 'Run `claude` on that machine once; it refreshes the token on use.' };
    }
    const r = await httpJson(USAGE_URL, {
      headers: { authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
    });
    if (r.status === 401 || r.status === 403) {
      return { ...base, error: `Anthropic rejected the token (${r.status})`, hint: 'Run `claude` on that machine once to refresh the login.' };
    }
    if (r.status >= 400 || !isObj(r.body)) {
      return { ...base, error: `Unexpected response from Anthropic (${r.status})`, hint: r.text.slice(0, 200) || null };
    }
    const windows = parseUsageBody(r.body);
    if (windows.length === 0) return { ...base, error: 'No usage windows in the response', hint: r.text.slice(0, 200) || null };
    return { ...base, ok: true, windows };
  },
};
