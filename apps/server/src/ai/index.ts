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
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, AiAccountUsage>();

/** Usage for one account: reads the CLI credential on the machine, asks the provider, caches for 60 s. */
export async function getAccountUsage(account: AiAccount, machine: Machine | undefined, refresh = false): Promise<AiAccountUsage> {
  const cached = cache.get(account.id);
  if (cached && !refresh && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_TTL_MS) return cached;

  const fetched_at = new Date().toISOString();
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
  cache.set(account.id, result);
  return result;
}

export function forgetAccountUsage(accountId: string): void {
  cache.delete(accountId);
}
