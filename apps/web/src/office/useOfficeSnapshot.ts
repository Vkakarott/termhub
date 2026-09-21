import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { OfficeSnapshot } from '../lib/types';

const REFRESH_MS = 60_000;
/** Floor of the gap between two reads asked for by window focus or by the tab becoming visible. */
const MIN_GAP_MS = 10_000;

/**
 * The floor snapshot of one machine: read on mount, on window focus, when the browser tab becomes
 * visible again, every minute while it is visible, and whenever `reload` is called (a monitor push
 * named a tab the snapshot lacks). A failed re-read keeps the last snapshot on screen; only a
 * failed first read is an error.
 *
 * A view meant to be left open all day must not poll for a floor nobody is looking at, and
 * alt-tabbing in and out must not turn into one GET per switch — hence the visibility gate and the
 * 10 s floor on the focus/visibility triggers. `reload()` is exempt: it means a tab the snapshot
 * does not know about is already on screen.
 *
 * `generation` guards against two races around switching machines: a request for the old machine
 * that is still in flight must not land in state after the new machine's effect has taken over
 * (it would show the wrong floor), and switching machines must not stay blocked by the old
 * request's `inFlight` flag — the new machine's first read has to fire immediately, not wait for
 * the next tick or a window focus.
 */
export function useOfficeSnapshot(machineId: string | null): { snapshot: OfficeSnapshot | null; error: string | null; reload: () => boolean } {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const lastRead = useRef(0);

  /** Returns whether a request was actually started (false while one is already in flight). */
  const read = useCallback(
    (throttled: boolean): boolean => {
      if (!machineId || inFlight.current) return false;
      if (throttled && Date.now() - lastRead.current < MIN_GAP_MS) return false;
      lastRead.current = Date.now();
      inFlight.current = true;
      const gen = generation.current;
      api
        .office(machineId)
        .then((s) => {
          if (gen !== generation.current) return; // the machine changed while this request was in flight
          setSnapshot(s);
          setError(null);
        })
        .catch(() => {
          if (gen !== generation.current) return;
          setError('Não foi possível carregar o escritório desta máquina.');
        })
        .finally(() => {
          if (gen === generation.current) inFlight.current = false;
        });
      return true;
    },
    [machineId],
  );
  const reload = useCallback(() => read(false), [read]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setSnapshot(null);
    setError(null);
    read(false);
    const tick = () => {
      if (document.visibilityState === 'visible') read(false);
    };
    const onFocus = () => read(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') read(true);
    };
    const timer = setInterval(tick, REFRESH_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read]);

  return { snapshot, error: snapshot ? null : error, reload };
}
