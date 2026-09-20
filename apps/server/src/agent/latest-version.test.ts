import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { agents } from './registry.js';
import {
  autoUpdateTick,
  fetchLatestAgentVersion,
  isOutdated,
  latestAgentVersion,
  resetAutoUpdateAttempts,
  setLatestAgentVersion,
  startAgentVersionPoller,
  REFRESH_MS,
} from './latest-version.js';

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

describe('autoUpdateTick', () => {
  function attach(id: string, version: string, channels: number, rpc = vi.fn(async () => ({ installed_version: '0.2.5', restart: 'service' }))) {
    const conn = Object.assign(new EventEmitter(), {
      hello: { type: 'hello', protocol: 1, agent_version: version, os: 'macos', tools: ['tmux'] },
      connectedAt: Date.now(),
      openChannels: channels,
      rpc,
      close: vi.fn(),
    });
    agents.attach(id, conn as never);
    return rpc;
  }
  const machine = (id: string) => ({ id, type: 'agent', agent_auto_update: true }) as never;
  const repos = (ids: string[]) => ({ machines: { listAutoUpdate: async () => ids.map(machine) } }) as unknown as Repositories;

  afterEach(() => {
    agents.reset();
    resetAutoUpdateAttempts();
  });

  it('updates only online, outdated, idle machines that know the RPC — once per version', async () => {
    setLatestAgentVersion('0.2.5');
    const idle = attach('idle', '0.2.1', 0);
    const busy = attach('busy', '0.2.1', 2);
    const fresh = attach('fresh', '0.2.5', 0);
    const old = attach('old', '0.2.0', 0);
    await autoUpdateTick(repos(['idle', 'busy', 'fresh', 'old', 'offline']), log);
    expect(idle).toHaveBeenCalledWith('agent.update', { version: '0.2.5' }, 180_000);
    expect(busy).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
    expect(old).not.toHaveBeenCalled();
    await autoUpdateTick(repos(['idle']), log);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('does nothing before the latest version is known and survives a failing agent', async () => {
    const rpc = attach('idle', '0.2.1', 0, vi.fn(async () => { throw new Error('boom'); }));
    await autoUpdateTick(repos(['idle']), log);
    expect(rpc).not.toHaveBeenCalled();
    setLatestAgentVersion('0.2.5');
    await expect(autoUpdateTick(repos(['idle']), log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
