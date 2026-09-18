import { DEFAULT_CONFIG_DIRS } from '@termhub/machine-ops';
import type { AiAccount, AiProvider, Machine } from '../db/repositories/types.js';
import { claudeAdapter } from './claude.js';
import { chatgptAdapter } from './chatgpt.js';
import { geminiAdapter } from './gemini.js';
import { antigravityAdapter } from './antigravity.js';
import { CredentialError, readCredential } from './credentials.js';
import type { AiProviderAdapter, AiUsageResult } from './types.js';

export type { AiUsageResult, AiUsageWindow } from './types.js';

const ADAPTERS: Record<AiProvider, AiProviderAdapter> = { claude: claudeAdapter, chatgpt: chatgptAdapter, gemini: geminiAdapter, antigravity: antigravityAdapter };

export interface AiAccountUsage extends AiUsageResult {
  account_id: string;
  fetched_at: string;
  /** the last successful reading, kept because the provider is currently rate-limiting us */
  stale?: boolean;
}

/** Providers rate-limit their usage endpoints; one query per account every few minutes is plenty for 5 h / 7 d windows. */
const CACHE_TTL_MS = 5 * 60_000;
/** A manual refresh (↻) still cannot hit the provider more often than this. */
const MIN_REFRESH_MS = 30_000;
/** After a 429 without Retry-After, wait this long before asking again. */
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

interface Entry {
  result: AiAccountUsage;
  /** last time the provider was actually asked */
  asked_at: number;
  /** do not ask the provider again before this time (rate-limit back-off) */
  blocked_until: number;
  /** last ok result, reused while rate-limited */
  last_ok: AiAccountUsage | null;
}
const cache = new Map<string, Entry>();

/**
 * Usage for one account: reads the CLI credential on the machine and asks the provider.
 * Cached per account; `refresh` shortens the cache to MIN_REFRESH_MS but never bypasses a
 * rate-limit back-off. While rate-limited, the last successful reading is returned as stale.
 */
export async function getAccountUsage(account: AiAccount, machine: Machine | undefined, refresh = false): Promise<AiAccountUsage> {
  const now = Date.now();
  const entry = cache.get(account.id);
  if (entry) {
    const age = now - entry.asked_at;
    if (now < entry.blocked_until || age < (refresh ? MIN_REFRESH_MS : CACHE_TTL_MS)) return entry.result;
  }

  const fetched_at = new Date(now).toISOString();
  const fail = (error: string, hint: string | null = null): AiAccountUsage => ({ account_id: account.id, fetched_at, ok: false, plan: null, windows: [], error, hint });

  let result: AiAccountUsage;
  if (!machine) result = fail('Machine no longer exists');
  else {
    const adapter = ADAPTERS[account.provider];
    try {
      const cred = await readCredential(machine, adapter, account.config_dir, DEFAULT_CONFIG_DIRS[account.provider]);
      const usage = await adapter.fetchUsage(cred);
      result = { account_id: account.id, fetched_at, ...usage };
    } catch (err) {
      if (err instanceof CredentialError) result = fail(err.message, err.hint);
      else if (err instanceof Error && err.name === 'TimeoutError') result = fail('Provider did not answer in time');
      else result = fail(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  let blocked_until = 0;
  const last_ok = result.ok ? result : (entry?.last_ok ?? null);
  if (result.rate_limited) {
    blocked_until = now + (result.retry_after_ms ?? RATE_LIMIT_BACKOFF_MS);
    // keep the bars on screen: the old numbers beat an error box
    if (last_ok) result = { ...last_ok, stale: true, hint: result.hint };
  }
  cache.set(account.id, { result, asked_at: now, blocked_until, last_ok });
  return result;
}

export function forgetAccountUsage(accountId: string): void {
  cache.delete(accountId);
}
