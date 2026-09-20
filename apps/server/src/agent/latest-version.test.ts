import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestAgentVersion, isOutdated, latestAgentVersion, setLatestAgentVersion, startAgentVersionPoller, REFRESH_MS } from './latest-version.js';

const log = { info: vi.fn(), warn: vi.fn() };
const json = (status: number, body: unknown) => vi.fn(async () => ({ status, body, text: JSON.stringify(body), headers: new Headers() }));

afterEach(() => {
  setLatestAgentVersion(null);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('isOutdated', () => {
  it('is true only when both versions parse and current < latest', () => {
    expect(isOutdated('0.2.0', '0.2.1')).toBe(true);
    expect(isOutdated('0.2.1', '0.2.1')).toBe(false);
    expect(isOutdated('0.3.0', '0.2.9')).toBe(false);
    expect(isOutdated(null, '0.2.1')).toBe(false);
    expect(isOutdated('0.2.0', null)).toBe(false);
    expect(isOutdated('dev', '0.2.1')).toBe(false);
    expect(isOutdated('0.2.0', '0.2.1-beta')).toBe(false);
  });
});

describe('fetchLatestAgentVersion', () => {
  it('reads dist-tags latest from the registry', async () => {
    const f = json(200, { name: '@termhub/agent', version: '0.2.5' });
    expect(await fetchLatestAgentVersion(f)).toBe('0.2.5');
    expect(f).toHaveBeenCalledWith('https://registry.npmjs.org/@termhub/agent/latest', expect.objectContaining({ timeoutMs: 10_000 }));
  });
  it('returns null on a non-200, a malformed body or a thrown fetch', async () => {
    expect(await fetchLatestAgentVersion(json(503, {}))).toBeNull();
    expect(await fetchLatestAgentVersion(json(200, { version: 'latest' }))).toBeNull();
    expect(await fetchLatestAgentVersion(vi.fn(async () => { throw new Error('boom'); }))).toBeNull();
  });
});

describe('startAgentVersionPoller', () => {
  it('fetches at boot, caches, refreshes hourly and calls onRefresh after each success', async () => {
    vi.useFakeTimers();
    const f = json(200, { version: '0.2.5' });
    const onRefresh = vi.fn(async () => {});
    const stop = startAgentVersionPoller(log, onRefresh, f);
    expect(latestAgentVersion()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latestAgentVersion()).toBe('0.2.5');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(f).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('keeps the previous value and warns when a refresh fails', async () => {
    vi.useFakeTimers();
    setLatestAgentVersion('0.2.4');
    const stop = startAgentVersionPoller(log, undefined, json(500, {}));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latestAgentVersion()).toBe('0.2.4');
    expect(log.warn).toHaveBeenCalled();
    stop();
  });
});
