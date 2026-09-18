/**
 * Google Analytics (GA4) through the Firebase JS SDK.
 *
 * The SDK is only reachable through dynamic `import()`, so it lands in its own
 * chunk and the initial bundle stays as it was. Nothing here runs before the
 * visitor accepts cookies (see `consent.ts` / `CookieBanner.tsx`), and every
 * failure is swallowed: an ad blocker must never break the page.
 */

import type { Analytics } from 'firebase/analytics';

const env = import.meta.env;

/** No config (dev, CI, forks) means the landing ships with no analytics at all. */
export const ANALYTICS_ENABLED: boolean =
  !env.DEV &&
  Boolean(env.VITE_FIREBASE_MEASUREMENT_ID && env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_APP_ID && env.VITE_FIREBASE_PROJECT_ID);

export type Lang = 'pt' | 'en';
export type AnalyticsEvent = 'cta_click' | 'waitlist_submit' | 'lang_switch';

/** Set on the first `initAnalytics` call, so a second call never initialises twice. */
let pending: Promise<Analytics | null> | null = null;
let instance: Analytics | null = null;

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

async function load(lang: Lang): Promise<Analytics | null> {
  const [{ initializeApp }, { getAnalytics, isSupported, setUserProperties }] = await Promise.all([
    import('firebase/app'),
    import('firebase/analytics'),
  ]);
  if (!(await isSupported())) return null;
  const analytics = getAnalytics(initializeApp(firebaseConfig()));
  setUserProperties(analytics, { lang });
  instance = analytics;
  return analytics;
}

/** Loads and starts analytics. Safe to call more than once; only the first call does the work. */
export function initAnalytics(lang: Lang): void {
  if (!ANALYTICS_ENABLED || pending) return;
  pending = new Promise<Analytics | null>((resolve) => {
    whenIdle(() => {
      load(lang)
        .then(resolve)
        .catch((err) => {
          console.debug('[analytics] disabled:', err);
          resolve(null);
        });
    });
  });
}

/** Reports an event. A no-op while analytics is off or not accepted, and never sends personal data. */
export function track(event: AnalyticsEvent, params?: Record<string, string | number | boolean>): void {
  if (!ANALYTICS_ENABLED || !pending) return;
  void pending
    .then(async (analytics) => {
      if (!analytics) return;
      const { logEvent } = await import('firebase/analytics');
      logEvent(analytics, event, params);
    })
    .catch((err) => console.debug('[analytics] event dropped:', err));
}

/** Keeps the `lang` user property in sync with the language switch. */
export function setLang(lang: Lang): void {
  if (!ANALYTICS_ENABLED || !instance) return;
  const analytics = instance;
  void import('firebase/analytics')
    .then(({ setUserProperties }) => setUserProperties(analytics, { lang }))
    .catch((err) => console.debug('[analytics] lang not set:', err));
}
