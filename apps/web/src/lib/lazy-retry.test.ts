import { describe, expect, it, vi } from 'vitest';
import { retryOnceOnImportFailure, type ReloadEnv } from './lazy-retry';

function fakeEnv(): ReloadEnv & { tried: boolean; reloads: number } {
  return {
    tried: false,
    reloads: 0,
    hasTried() {
      return this.tried;
    },
    markTried() {
      this.tried = true;
    },
    clearTried() {
      this.tried = false;
    },
    reload() {
      this.reloads += 1;
    },
  };
}

describe('retryOnceOnImportFailure', () => {
  it('reloads the page once when the chunk is gone (a deploy changed its hash)', async () => {
    const env = fakeEnv();
    const load = vi.fn(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    // the promise stays pending on purpose: the document is about to be replaced, so React keeps
    // the Suspense fallback instead of flashing an error for the instant before the reload lands
    let settled = false;
    void retryOnceOnImportFailure(load, env)().then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(env.reloads).toBe(1);
    expect(env.tried).toBe(true);
    expect(settled).toBe(false);
  });

  it('gives up after the reload already happened, so a broken chunk cannot loop', async () => {
    const env = fakeEnv();
    env.tried = true;
    const err = new Error('Failed to fetch dynamically imported module');
    await expect(retryOnceOnImportFailure(() => Promise.reject(err), env)()).rejects.toBe(err);
    expect(env.reloads).toBe(0);
  });

  it('clears the flag on a successful import, so the next deploy gets its own retry', async () => {
    const env = fakeEnv();
    env.tried = true;
    const mod = { default: 'page' };
    await expect(retryOnceOnImportFailure(() => Promise.resolve(mod), env)()).resolves.toBe(mod);
    expect(env.tried).toBe(false);
    expect(env.reloads).toBe(0);
  });
});
