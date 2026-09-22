import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { OfficeSnapshot } from '../lib/types';

const REFRESH_MS = 60_000;
/** Floor of the gap between two reads of one machine asked for by window focus or by the tab becoming visible. */
const MIN_GAP_MS = 10_000;

export interface MachineSnapshotState {
  snapshot: OfficeSnapshot | null;
  /** the FIRST read failed; a failed re-read keeps the last snapshot and is not an error */
  failed: boolean;
}

const EMPTY: MachineSnapshotState = { snapshot: null, failed: false };

/**
 * The floor snapshot of every machine, each read on its own: a block appears as soon as its
 * machine answers, and a machine that is slow or down delays only itself. Same cadence as a single
 * floor had — mount, every minute while the browser tab is visible, window focus and becoming
 * visible (10 s apart at least), and `reload(id)` when the monitor names a tab that machine's
 * snapshot lacks. `reload` skips the floor and asks the server for a fresh tmux probe: the tab is
 * already on screen and must not read as "no session yet" from the server's memo.
 *
 * A removed machine's id can linger in `inFlight` until its request settles; if it is re-added
 * before then, that read is skipped once (see the "re-add" tests) and the machine is picked up
 * again on the next tick or the next window focus — both pinned by a test, and a tab becoming
 * visible asks through the same path as focus. It never gets stuck.
 */
export function useOfficeSnapshots(machineIds: string[]): { byMachine: Record<string, MachineSnapshotState>; reload: (machineId: string) => boolean } {
  const key = [...machineIds].sort().join('\n');
  const ids = useMemo(() => (key ? key.split('\n') : []), [key]);
  const [states, setStates] = useState<Record<string, MachineSnapshotState>>({});
  const wanted = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const lastRead = useRef(new Map<string, number>());

  const read = useCallback((id: string, opts: { throttled?: boolean; fresh?: boolean } = {}): boolean => {
    if (!wanted.current.has(id) || inFlight.current.has(id)) return false;
    if (opts.throttled && Date.now() - (lastRead.current.get(id) ?? 0) < MIN_GAP_MS) return false;
    lastRead.current.set(id, Date.now());
    inFlight.current.add(id);
    api
      .office(id, opts.fresh ?? false)
      .then((snapshot) => {
        if (wanted.current.has(id)) setStates((s) => ({ ...s, [id]: { snapshot, failed: false } }));
      })
      .catch(() => {
        if (wanted.current.has(id)) setStates((s) => (s[id]?.snapshot ? s : { ...s, [id]: { snapshot: null, failed: true } }));
      })
      .finally(() => inFlight.current.delete(id));
    return true;
  }, []);

  // the set of machines: read the new ones, forget the ones that left
  useEffect(() => {
    const next = new Set(ids);
    const added = ids.filter((id) => !wanted.current.has(id));
    wanted.current = next;
    setStates((s) => {
      const kept = Object.fromEntries(Object.entries(s).filter(([id]) => next.has(id)));
      return Object.keys(kept).length === Object.keys(s).length ? s : kept;
    });
    for (const id of [...lastRead.current.keys()]) if (!next.has(id)) lastRead.current.delete(id);
    for (const id of added) read(id);
  }, [ids, read]);

  useEffect(() => {
    const all = (throttled: boolean) => {
      if (document.visibilityState !== 'visible') return;
      for (const id of wanted.current) read(id, { throttled });
    };
    const timer = setInterval(() => all(false), REFRESH_MS);
    const onFocus = () => all(true);
    const onVisible = () => all(true);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read]);

  const byMachine = useMemo(() => Object.fromEntries(ids.map((id) => [id, states[id] ?? EMPTY])), [ids, states]);
  const reload = useCallback((machineId: string) => read(machineId, { fresh: true }), [read]);
  return { byMachine, reload };
}
