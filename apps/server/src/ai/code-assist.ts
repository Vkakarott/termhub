import type { AiCredential, AiUsageResult, AiUsageWindow } from './types.js';
import { httpJson, isObj, num, str, toIso } from './credentials.js';

/**
 * Google Code Assist usage (shared by the Gemini CLI and Antigravity CLI adapters,
 * which both authenticate the same Google account against the same endpoints).
 * Best effort: undocumented.
 */
const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal';

export interface CodeAssistOptions {
  expired: string;
  refresh: string;
  /**
   * The backend picks which product licence to check from the client identity: a request that
   * does not look like the Antigravity IDE is checked against Gemini Code Assist, which an
   * Antigravity-only account does not have (403 "no valid license"). So Antigravity requests
   * mirror the IDE (User-Agent + Client-Metadata) and read the ready-made quota summary.
   */
  ide: 'gemini' | 'antigravity';
}

const ANTIGRAVITY_HEADERS = {
  'user-agent': 'Antigravity/1.0.0',
  'client-metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform: 'MACOS', pluginType: 'GEMINI' }),
};

const clamp = (n: number) => Math.max(0, Math.min(100, n));

const SUMMARY_WINDOW_LABELS: Record<string, string> = { '5h': '5 horas', weekly: '7 dias', daily: '24 horas' };

/** retrieveUserQuotaSummary: { groups: [{ displayName?, buckets: [{ bucketId, displayName, window, resetTime, remainingFraction }] }] } */
export function parseQuotaSummary(body: Record<string, unknown>): AiUsageWindow[] {
  const windows: AiUsageWindow[] = [];
  const groups = Array.isArray(body.groups) ? body.groups : [];
  for (const g of groups) {
    if (!isObj(g)) continue;
    const groupName = str(g.displayName) ?? str(g.name) ?? str(g.id);
    const buckets = Array.isArray(g.buckets) ? g.buckets : [];
    for (const b of buckets) {
      if (!isObj(b)) continue;
      const fraction = num(b.remainingFraction);
      if (fraction === null) continue;
      const id = str(b.bucketId) ?? str(b.displayName) ?? 'quota';
      const win = str(b.window);
      const winLabel = win ? (SUMMARY_WINDOW_LABELS[win] ?? win) : (str(b.displayName) ?? id);
      windows.push({ key: id, label: groupName ? `${winLabel} · ${groupName}` : winLabel, utilization: clamp((1 - fraction) * 100), resets_at: toIso(b.resetTime) });
    }
  }
  return windows;
}

/** retrieveUserQuota: { buckets: [{ modelId, tokenType, resetTime, remainingFraction }] } */
export function parseQuotaBuckets(body: Record<string, unknown>): AiUsageWindow[] {
  const windows: AiUsageWindow[] = [];
  const buckets = Array.isArray(body.buckets) ? body.buckets : [];
  for (const b of buckets) {
    if (!isObj(b)) continue;
    const fraction = num(b.remainingFraction);
    if (fraction === null) continue;
    const model = str(b.modelId) ?? 'quota';
    const type = str(b.tokenType);
    windows.push({ key: `${model}:${type ?? ''}`, label: type ? `${model} · ${type.toLowerCase()}` : model, utilization: clamp((1 - fraction) * 100), resets_at: toIso(b.resetTime) });
  }
  return windows;
}

export async function fetchCodeAssistUsage(cred: AiCredential, opts: CodeAssistOptions): Promise<AiUsageResult> {
  const base: AiUsageResult = { ok: false, plan: null, windows: [], error: null, hint: null };
  if (cred.expires_at && cred.expires_at < Date.now()) {
    return { ...base, error: 'Google token expired', hint: opts.expired };
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${cred.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...(opts.ide === 'antigravity' ? ANTIGRAVITY_HEADERS : {}),
  };
  const post = (endpoint: string, body: unknown) => httpJson(`${CODE_ASSIST}:${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });

  // 1) which Code Assist project / tier this account has
  const load = await post('loadCodeAssist', { metadata: { ideType: opts.ide === 'antigravity' ? 'ANTIGRAVITY' : 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } });
  if (load.status === 401 || load.status === 403) return { ...base, error: `Google rejected the token (${load.status})`, hint: opts.refresh };
  if (load.status >= 400 || !isObj(load.body)) return { ...base, error: `Unexpected response from Google (${load.status})`, hint: load.text.slice(0, 200) || null };
  const tier = isObj(load.body.currentTier) ? (str(load.body.currentTier.name) ?? str(load.body.currentTier.id)) : null;
  const project = str(load.body.cloudaicompanionProject) ?? (isObj(load.body.cloudaicompanionProject) ? str(load.body.cloudaicompanionProject.id) : null);

  // 2) Antigravity: the per-window summary (5h / weekly), which is what the IDE shows
  if (opts.ide === 'antigravity') {
    const summary = await post('retrieveUserQuotaSummary', {});
    if (summary.status < 400 && isObj(summary.body)) {
      const windows = parseQuotaSummary(summary.body);
      if (windows.length > 0) return { ...base, ok: true, plan: tier, windows };
    }
  }

  // 3) raw per-model buckets — with and without the project; first 2xx wins
  const bodies: unknown[] = project ? [{ project }, {}] : [{}];
  if (opts.ide === 'antigravity') bodies.reverse();
  let quota = await post('retrieveUserQuota', bodies[0]);
  if ((quota.status >= 400 || !isObj(quota.body)) && bodies.length > 1) quota = await post('retrieveUserQuota', bodies[1]);
  if (quota.status >= 400 || !isObj(quota.body)) return { ...base, plan: tier, error: `Quota endpoint answered ${quota.status}`, hint: quota.text.slice(0, 200) || null };
  const windows = parseQuotaBuckets(quota.body);
  if (windows.length === 0) return { ...base, plan: tier, error: 'No quota buckets in the response', hint: quota.text.slice(0, 200) || null };
  return { ...base, ok: true, plan: tier, windows };
}
