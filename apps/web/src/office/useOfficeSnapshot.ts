import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { OfficeSnapshot } from '../lib/types';

const REFRESH_MS = 60_000;

/**
 * The floor snapshot of one machine: read on mount, on window focus, every minute, and whenever
 * `reload` is called (a monitor push named a tab the snapshot lacks). A failed re-read keeps the
 * last snapshot on screen; only a failed first read is an error.
 *
 * `generation` guards against two races around switching machines: a request for the old machine
 * that is still in flight must not land in state after the new machine's effect has taken over
 * (it would show the wrong floor), and switching machines must not stay blocked by the old
 * request's `inFlight` flag — the new machine's first read has to fire immediately, not wait for
 * the next tick or a window focus.
 */
export function useOfficeSnapshot(machineId: string | null): { snapshot: OfficeSnapshot | null; error: string | null; reload: () => void } {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);

  const reload = useCallback(() => {
    if (!machineId || inFlight.current) return;
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
  }, [machineId]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setSnapshot(null);
    setError(null);
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    window.addEventListener('focus', reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', reload);
    };
  }, [reload]);

  return { snapshot, error: snapshot ? null : error, reload };
}
