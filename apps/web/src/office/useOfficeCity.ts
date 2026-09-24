import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { OfficeCity } from '../lib/types';

const REFRESH_MS = 60_000;
/** Floor of the gap between two reads asked for by window focus or by the tab becoming visible. */
const MIN_GAP_MS = 10_000;

/**
 * The whole office city in one read (GET /api/office): on mount, every minute while the browser tab
 * is visible, on window focus and on becoming visible (10 s apart at least), and on `reload()` —
 * which the page calls when the monitor names a tab the city lacks, and which asks the server for a
 * fresh tmux probe (that tab is already on screen and must not read as "no session yet"). One read
 * in flight at a time. `failed` is only about the FIRST read: a failed re-read keeps the last city,
 * which is still the best picture there is, and sets `stale` (cleared by the next good read) so the
 * page can say that picture is old. Nothing is read while `enabled` is false (a role that
 * cannot read projects or terminals is sent away by the page anyway).
 */
export function useOfficeCity(enabled: boolean): { city: OfficeCity | null; failed: boolean; stale: boolean; reload: () => boolean } {
  const [city, setCity] = useState<OfficeCity | null>(null);
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const hasCity = useRef(false);
  const inFlight = useRef(false);
  const lastRead = useRef(0);
  const mounted = useRef(true);

  const read = useCallback((opts: { throttled?: boolean; fresh?: boolean } = {}): boolean => {
    if (!enabledRef.current || inFlight.current) return false;
    if (opts.throttled && Date.now() - lastRead.current < MIN_GAP_MS) return false;
    lastRead.current = Date.now();
    inFlight.current = true;
    api
      .office(opts.fresh ?? false)
      .then((next) => {
        if (!mounted.current) return;
        hasCity.current = true;
        setCity(next);
        setFailed(false);
        setStale(false);
      })
      .catch(() => {
        if (!mounted.current) return;
        if (hasCity.current) setStale(true);
        else setFailed(true);
      })
      .finally(() => {
        inFlight.current = false;
      });
    return true;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (enabled) read();
  }, [enabled, read]);

  useEffect(() => {
    const again = (throttled: boolean) => {
      if (document.visibilityState === 'visible') read({ throttled });
    };
    const timer = setInterval(() => again(false), REFRESH_MS);
    const onFocus = () => again(true);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [read]);

  const reload = useCallback(() => read({ fresh: true }), [read]);
  return { city, failed, stale, reload };
}
