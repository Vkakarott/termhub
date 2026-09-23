import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * `?tab=<id>` (from a task card or a sidebar agent) focuses that tab. The param is read once and
 * cleared at once; the wanted id stays pending until the tab list has it. A tab this view does not
 * know yet (opened elsewhere a moment ago) triggers one reload, and the id is dropped only when
 * that reload comes back without it — so the click is not lost when the reload lands later.
 */
export function useFocusTabFromParam(tabs: ReadonlyArray<{ id: string }> | null, load: () => unknown, focus: (tabId: string) => void): void {
  const [searchParams, setSearchParams] = useSearchParams();
  /** `reloadedFrom`: the list a reload was asked from (undefined = not reloaded yet) */
  const pending = useRef<{ id: string; reloadedFrom?: ReadonlyArray<{ id: string }> } | null>(null);
  /** the params already read: the effect also re-runs for tab list changes before the cleared URL lands */
  const consumed = useRef<URLSearchParams | null>(null);

  useEffect(() => {
    const wanted = consumed.current === searchParams ? null : searchParams.get('tab');
    consumed.current = searchParams;
    if (wanted) {
      pending.current = { id: wanted };
      setSearchParams(
        (p) => {
          p.delete('tab');
          return p;
        },
        { replace: true },
      );
    }
    const p = pending.current;
    if (!p || !tabs) return;
    if (tabs.some((t) => t.id === p.id)) {
      pending.current = null;
      focus(p.id);
    } else if (p.reloadedFrom === undefined) {
      p.reloadedFrom = tabs;
      void load();
    } else if (tabs !== p.reloadedFrom) {
      pending.current = null; // the reload came back without it: a closed or foreign tab
    }
  }, [searchParams, tabs, setSearchParams, load, focus]);
}
