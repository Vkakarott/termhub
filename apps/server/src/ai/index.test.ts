import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccount, Machine } from '../db/repositories/types.js';
import type { AiUsageResult } from './types.js';

const fetchUsage = vi.fn<() => Promise<AiUsageResult>>();
vi.mock('./credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credentials.js')>()),
  readCredential: vi.fn(async () => ({ token: 't', extra: {}, expires_at: null, plan: 'max' })),
}));
vi.mock('./claude.js', () => ({ claudeAdapter: { provider: 'claude', loginHint: '', credentialScript: () => '', parseCredential: () => ({}), fetchUsage: () => fetchUsage() } }));

const { forgetAccountUsage, getAccountUsage } = await import('./index.js');

const account = { id: 'acc1', provider: 'claude', label: 'x', machine_id: 'm1', config_dir: null } as unknown as AiAccount;
const machine = { id: 'm1', type: 'local' } as unknown as Machine;
const ok = (utilization: number): AiUsageResult => ({ ok: true, plan: 'max', windows: [{ key: 'five_hour', label: '5 horas', utilization, resets_at: null }], error: null, hint: null });
const limited: AiUsageResult = { ok: false, plan: null, windows: [], error: 'Anthropic rate-limited the usage query', hint: 'later', rate_limited: true, retry_after_ms: null };

describe('getAccountUsage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
    fetchUsage.mockReset();
    forgetAccountUsage(account.id);
  });
  afterEach(() => vi.useRealTimers());

  it('asks the provider once per 5 minutes and honours a manual refresh only after 30 s', async () => {
    fetchUsage.mockResolvedValue(ok(10));
    await getAccountUsage(account, machine);
    await getAccountUsage(account, machine);
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    await getAccountUsage(account, machine, true); // too soon even for ↻
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000);
    await getAccountUsage(account, machine, true);
    expect(fetchUsage).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(4 * 60_000);
    await getAccountUsage(account, machine);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2 * 60_000);
    await getAccountUsage(account, machine);
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });

  it('keeps the last good reading as stale while rate-limited and backs off, even on manual refresh', async () => {
    fetchUsage.mockResolvedValueOnce(ok(42));
    const first = await getAccountUsage(account, machine);
    expect(first.ok).toBe(true);

    vi.advanceTimersByTime(6 * 60_000);
    fetchUsage.mockResolvedValue(limited);
    const stale = await getAccountUsage(account, machine);
    expect(stale.ok).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.windows[0].utilization).toBe(42);
    expect(stale.fetched_at).toBe(first.fetched_at);
    expect(stale.hint).toBe('later');

    vi.advanceTimersByTime(5 * 60_000);
    await getAccountUsage(account, machine, true);
    expect(fetchUsage).toHaveBeenCalledTimes(2); // still backing off (10 min)

    vi.advanceTimersByTime(6 * 60_000);
    fetchUsage.mockResolvedValue(ok(50));
    const fresh = await getAccountUsage(account, machine);
    expect(fetchUsage).toHaveBeenCalledTimes(3);
    expect(fresh.stale).toBeUndefined();
    expect(fresh.windows[0].utilization).toBe(50);
  });

  it('uses Retry-After for the back-off and surfaces the error when there is no earlier reading', async () => {
    fetchUsage.mockResolvedValue({ ...limited, retry_after_ms: 60_000 });
    const r = await getAccountUsage(account, machine);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Anthropic rate-limited the usage query');

    vi.advanceTimersByTime(59_000);
    await getAccountUsage(account, machine, true);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await getAccountUsage(account, machine, true);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });
});
