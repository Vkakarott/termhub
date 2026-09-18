import type { AiCredential, AiUsageResult, AiUsageWindow } from './types.js';
import { httpJson, isObj, num, str, toIso } from './credentials.js';

/**
 * Google Code Assist usage (shared by the Gemini CLI and Antigravity CLI adapters,
 * which both authenticate the same Google account against the same endpoints).
 * Best effort: undocumented.
 */
const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal';

export async function fetchCodeAssistUsage(cred: AiCredential, hints: { expired: string; refresh: string }): Promise<AiUsageResult> {
  const base: AiUsageResult = { ok: false, plan: null, windows: [], error: null, hint: null };
  if (cred.expires_at && cred.expires_at < Date.now()) {
    return { ...base, error: 'Google token expired', hint: hints.expired };
  }
  const headers = { authorization: `Bearer ${cred.token}`, 'content-type': 'application/json', accept: 'application/json' };

  // 1) which Code Assist project / tier this account has
  const load = await httpJson(`${CODE_ASSIST}:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
  });
  if (load.status === 401 || load.status === 403) return { ...base, error: `Google rejected the token (${load.status})`, hint: hints.refresh };
  if (load.status >= 400 || !isObj(load.body)) return { ...base, error: `Unexpected response from Google (${load.status})`, hint: load.text.slice(0, 200) || null };
  const tier = isObj(load.body.currentTier) ? (str(load.body.currentTier.name) ?? str(load.body.currentTier.id)) : null;
  const project = str(load.body.cloudaicompanionProject) ?? (isObj(load.body.cloudaicompanionProject) ? str(load.body.cloudaicompanionProject.id) : null);

  // 2) quota buckets
  const quota = await httpJson(`${CODE_ASSIST}:retrieveUserQuota`, { method: 'POST', headers, body: JSON.stringify(project ? { project } : {}) });
  if (quota.status >= 400 || !isObj(quota.body)) return { ...base, plan: tier, error: `Quota endpoint answered ${quota.status}`, hint: quota.text.slice(0, 200) || null };
  const buckets = Array.isArray(quota.body.buckets) ? quota.body.buckets : [];
  const windows: AiUsageWindow[] = [];
  for (const b of buckets) {
    if (!isObj(b)) continue;
    const fraction = num(b.remainingFraction);
    if (fraction === null) continue;
    const model = str(b.modelId) ?? 'quota';
    const type = str(b.tokenType);
    windows.push({ key: `${model}:${type ?? ''}`, label: type ? `${model} · ${type.toLowerCase()}` : model, utilization: Math.max(0, Math.min(100, (1 - fraction) * 100)), resets_at: toIso(b.resetTime) });
  }
  if (windows.length === 0) return { ...base, plan: tier, error: 'No quota buckets in the response', hint: quota.text.slice(0, 200) || null };
  return { ...base, ok: true, plan: tier, windows };
}
