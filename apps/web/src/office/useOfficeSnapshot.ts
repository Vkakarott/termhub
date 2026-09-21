import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { OfficeSnapshot } from '../lib/types';

const REFRESH_MS = 60_000;

/**
 * The floor snapshot of one machine: read on mount, on window focus, every minute, and whenever
 * `reload` is called (a monitor push named a tab the snapshot lacks). A failed re-read keeps the
 * last snapshot on screen; only a failed first read is an error.
 */
export function useOfficeSnapshot(machineId: string | null): { snapshot: OfficeSnapshot | null; error: string | null; reload: () => void } {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const reload = useCallback(() => {
    if (!machineId || inFlight.current) return;
    inFlight.current = true;
    api
      .office(machineId)
      .then((s) => {
        setSnapshot(s);
        setError(null);
      })
      .catch(() => setError('Não foi possível carregar o escritório desta máquina.'))
      .finally(() => (inFlight.current = false));
  }, [machineId]);

  useEffect(() => {
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
