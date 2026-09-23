import type { Tab } from './types';

/** The /ws/monitor frames that touch the open-tab list (see server monitor/ws.ts). */
export type OpenTabFrame =
  | { type: 'tab'; tab: Partial<Tab> & { id: string } }
  | { type: 'tab_upsert'; tab: Tab }
  | { type: 'tab_removed'; tab_id: string };

/**
 * Applies one monitor push to the open terminal tabs (the sidebar's agents): a tab opened or
 * renamed is added or replaced, a closed one leaves at once, and a state change updates the tab
 * so its dot follows live. Returns the same array when nothing changed.
 */
export function applyOpenTabFrame(list: Tab[], frame: OpenTabFrame): Tab[] {
  if (frame.type === 'tab_removed') {
    return list.some((t) => t.id === frame.tab_id) ? list.filter((t) => t.id !== frame.tab_id) : list;
  }
  const idx = list.findIndex((t) => t.id === frame.tab.id);
  if (frame.type === 'tab_upsert') {
    if (frame.tab.kind !== 'terminal') return list;
    if (idx === -1) return [...list, frame.tab];
  } else if (idx === -1) {
    return list;
  }
  const next = list.slice();
  next[idx] = { ...list[idx], ...frame.tab };
  return next;
}
