import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ANALYTICS_ENABLED, disableAnalytics, initAnalytics, trackPageView } from '../lib/analytics';
import { readConsent, subscribeConsent } from '../lib/consent';
import { CookieBanner } from './CookieBanner';

const OPEN_EVENT = 'termhub:cookies-open';

/** Reopens the cookie banner (the "Cookies" link in the sidebar), so a stored choice can be changed. */
export function openCookieBanner(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/**
 * Ties consent to analytics for everything inside the router: starts the SDK on a
 * stored "granted", stops it on a withdrawal, reports route changes and shows the
 * cookie banner until the user answers. Renders only its children when analytics is
 * off (no config or dev build).
 */
export function AnalyticsGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [open, setOpen] = useState(() => ANALYTICS_ENABLED && readConsent() === null);

  // analytics starts only with a stored "granted"; withdrawing it stops collection at once,
  // without waiting for the next page load
  useEffect(() => {
    if (!ANALYTICS_ENABLED) return;
    if (readConsent() === 'granted') initAnalytics();
    const unsubscribe = subscribeConsent((consent) => {
      setOpen(false);
      if (consent === 'granted') initAnalytics();
      else disableAnalytics();
    });
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      unsubscribe();
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    trackPageView(location.pathname);
  }, [location.pathname]);

  return (
    <>
      {children}
      {ANALYTICS_ENABLED && <CookieBanner open={open} />}
    </>
  );
}
