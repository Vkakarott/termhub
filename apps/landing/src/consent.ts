/**
 * Cookie consent for the landing's Google Analytics.
 *
 * Nothing from Google is loaded before the visitor accepts, so there is no
 * Consent Mode signalling to do: the choice simply gates `initAnalytics`.
 */

export type Consent = 'granted' | 'denied';

const KEY = 'termhub:consent';
const EVENT = 'termhub:consent-change';

type Stored = { value: Consent; at: string };

/** The stored choice, or null when the visitor has not answered (or storage is unavailable). */
export function readConsent(): Consent | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return parsed.value === 'granted' || parsed.value === 'denied' ? parsed.value : null;
  } catch {
    // private mode, blocked storage or corrupted value: treat as "not answered"
    return null;
  }
}

/** Stores the choice and notifies the app. Failing to persist must not break the page. */
export function writeConsent(consent: Consent): void {
  const stored: Stored = { value: consent, at: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* ignore: the choice still applies to this page view */
  }
  try {
    window.dispatchEvent(new CustomEvent<Consent>(EVENT, { detail: consent }));
  } catch {
    /* ignore */
  }
}

/** Subscribes to consent changes made in this tab. Returns the unsubscribe function. */
export function subscribeConsent(cb: (consent: Consent) => void): () => void {
  const handler = (event: Event) => cb((event as CustomEvent<Consent>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
