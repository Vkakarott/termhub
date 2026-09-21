const RELOAD_KEY = 'termhub:chunk-reload';

/** The two bits of browser the retry needs, apart so it can be tested without one. */
export interface ReloadEnv {
  hasTried(): boolean;
  markTried(): void;
  clearTried(): void;
  reload(): void;
}

/** sessionStorage, not localStorage: the guard belongs to this tab and this session. */
export const browserReloadEnv: ReloadEnv = {
  hasTried() {
    try {
      return sessionStorage.getItem(RELOAD_KEY) === '1';
    } catch {
      return false; // storage blocked (private mode): the reload below is then simply not guarded
    }
  },
  markTried() {
    try {
      sessionStorage.setItem(RELOAD_KEY, '1');
    } catch {
      /* ignore */
    }
  },
  clearTried() {
    try {
      sessionStorage.removeItem(RELOAD_KEY);
    } catch {
      /* ignore */
    }
  },
  reload() {
    location.reload();
  },
};

/**
 * Wraps a `lazy()` import so a stale chunk does not blank the app. Every deploy changes the chunk
 * hashes, so a browser open since before one fails to import a route's chunk the moment the person
 * opens it — and a rejected lazy import unmounts the whole React tree. Reloading picks up the new
 * index.html; the flag makes sure a chunk that is genuinely broken fails instead of looping, and
 * the caller's error boundary is what shows that second failure.
 */
export function retryOnceOnImportFailure<T>(load: () => Promise<T>, env: ReloadEnv = browserReloadEnv): () => Promise<T> {
  return () =>
    load().then(
      (mod) => {
        env.clearTried();
        return mod;
      },
      (err: unknown) => {
        if (env.hasTried()) throw err;
        env.markTried();
        env.reload();
        // the document is on its way out: leave this pending so React keeps the Suspense fallback
        // on screen instead of flashing an error for the instant before the reload lands
        return new Promise<T>(() => {});
      },
    );
}
