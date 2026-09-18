/**
 * Google Analytics (GA4) through the Firebase JS SDK.
 *
 * The SDK is only reachable through dynamic `import()`, so it lands in its own
 * chunk and the initial bundle stays as it was. Nothing here runs before the
 * visitor accepts cookies (see `consent.ts` / `CookieBanner.tsx`), and loading
 * the SDK never breaks the page: an ad blocker just means no analytics.
 *
 * `ANALYTICS_ENABLED` is false under `npm run dev`, so the banner and this
 * module can only be exercised with `npm run build` + `npm run preview` and the
 * VITE_FIREBASE_* variables exported for that build.
 */

import type { Analytics } from 'firebase/analytics';
import type { Lang } from './i18n';

const env = import.meta.env;

/** No config (dev, CI, forks) means the landing ships with no analytics at all. */
export const ANALYTICS_ENABLED: boolean =
  !env.DEV &&
  Boolean(env.VITE_FIREBASE_MEASUREMENT_ID && env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_APP_ID && env.VITE_FIREBASE_PROJECT_ID);

export type AnalyticsEvent = 'cta_click' | 'waitlist_submit' | 'lang_switch';

/** Set on the first `initAnalytics` call, so a second call never initialises twice. */
let pending: Promise<Analytics | null> | null = null;
let instance: Analytics | null = null;
/** Set by `disableAnalytics`: withdrawing consent has to bite on this page view, not the next one. */
let disabled = false;
/** The language to report. Module-level so a switch during the dynamic import is not lost. */
let currentLang: Lang = 'pt';

function firebaseConfig() {
  return {
    apiKey: env.VITE_FIREBASE_API_KEY as string,
    projectId: env.VITE_FIREBASE_PROJECT_ID as string,
    appId: env.VITE_FIREBASE_APP_ID as string,
    measurementId: env.VITE_FIREBASE_MEASUREMENT_ID as string,
    ...(env.VITE_FIREBASE_AUTH_DOMAIN ? { authDomain: env.VITE_FIREBASE_AUTH_DOMAIN } : {}),
    ...(env.VITE_FIREBASE_STORAGE_BUCKET ? { storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET } : {}),
    ...(env.VITE_FIREBASE_MESSAGING_SENDER_ID ? { messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID } : {}),
  };
}

/** Runs `fn` once the page is idle, so loading the SDK never competes with the first paint. */
function whenIdle(fn: () => void): void {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => fn(), { timeout: 3000 });
  else window.setTimeout(fn, 1500);
}

type Sdk = typeof import('firebase/app') & typeof import('firebase/analytics');

let sdkPromise: Promise<Sdk | null> | null = null;

/**
 * Loads the SDK chunk once. Only the import itself is guarded: an extension can block
 * it, and that must stay silent — anything the SDK then throws is a bug and surfaces.
 */
function loadSdk(): Promise<Sdk | null> {
  sdkPromise ??= Promise.all([import('firebase/app'), import('firebase/analytics')])
    .then(([app, analytics]) => ({ ...app, ...analytics }))
    .catch((err) => {
      console.debug('[analytics] SDK not loaded:', err);
      return null;
    });
  return sdkPromise;
}

/** Expires the GA cookies on this host and on every parent domain GA could have written them to. */
function clearGaCookies(): void {
  const names = document.cookie
    .split(';')
    .map((entry) => entry.split('=')[0].trim())
    .filter((name) => name.startsWith('_ga') || name === '_gid');
  if (names.length === 0) return;
  // app.termhub.dev -> ["app.termhub.dev", "termhub.dev"]; a host with no dot (localhost) gets none
  const host = window.location.hostname;
  const parts = host.split('.');
  const domains = parts.map((_, i) => parts.slice(i).join('.')).filter((domain) => domain.includes('.'));
  const expired = 'Thu, 01 Jan 1970 00:00:00 GMT';
  for (const name of names) {
    document.cookie = `${name}=; expires=${expired}; path=/`;
    for (const domain of domains) {
      document.cookie = `${name}=; expires=${expired}; path=/; domain=${domain}`;
      document.cookie = `${name}=; expires=${expired}; path=/; domain=.${domain}`;
    }
  }
}

/** Flips collection on the instance, whenever it becomes available. */
function setCollection(enabled: boolean): Promise<void> {
  if (!pending) return Promise.resolve();
  return pending.then(async (analytics) => {
    if (!analytics) return;
    const sdk = await loadSdk();
    sdk?.setAnalyticsCollectionEnabled(analytics, enabled);
  });
}

async function load(): Promise<Analytics | null> {
  const sdk = await loadSdk();
  if (!sdk || !(await sdk.isSupported())) return null;
  const analytics = sdk.getAnalytics(sdk.initializeApp(firebaseConfig()));
  instance = analytics;
  // the visitor may have switched language or withdrawn consent while the SDK was loading
  sdk.setUserProperties(analytics, { lang: currentLang });
  if (disabled) {
    sdk.setAnalyticsCollectionEnabled(analytics, false);
    clearGaCookies();
  }
  return analytics;
}

/**
 * Starts analytics, or turns it back on after a withdrawal. The only "consent granted"
 * entry point; safe to call more than once, since only the first call loads the SDK.
 */
export function initAnalytics(lang: Lang): void {
  if (!ANALYTICS_ENABLED) return;
  currentLang = lang;
  const reEnabling = disabled;
  disabled = false;
  if (pending) {
    // the SDK is already loading or loaded: nothing to load, just collect again
    if (reEnabling) void setCollection(true);
    return;
  }
  pending = new Promise<Analytics | null>((resolve) => {
    whenIdle(() => {
      void load().then(resolve);
    });
  });
}

/**
 * Withdraws consent: stops collecting for the rest of this page view and drops the
 * GA cookies, so "Recusar" after "Aceitar" takes effect without a reload.
 */
export function disableAnalytics(): void {
  if (!ANALYTICS_ENABLED || disabled) return;
  disabled = true;
  clearGaCookies();
  // GA can still be writing cookies at the moment of the click: sweep again once collection is off
  void setCollection(false).then(clearGaCookies);
}

/** Reports an event. A no-op while analytics is off, not accepted or withdrawn; never sends personal data. */
export function track(event: AnalyticsEvent, params?: Record<string, string | number | boolean>): void {
  if (!ANALYTICS_ENABLED || disabled || !pending) return;
  void pending.then(async (analytics) => {
    if (!analytics || disabled) return;
    const sdk = await loadSdk();
    sdk?.logEvent(analytics, event, params);
  });
}

/** Keeps the `lang` user property in sync with the language switch. */
export function setLang(lang: Lang): void {
  currentLang = lang;
  if (!ANALYTICS_ENABLED || disabled || !instance) return;
  const analytics = instance;
  void loadSdk().then((sdk) => sdk?.setUserProperties(analytics, { lang: currentLang }));
}
