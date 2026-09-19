import { NEEDS_YOU, type MonitorItem, type Tab, type TabState } from './types';

const waiting = (s: TabState | null | undefined) => !!s && NEEDS_YOU.includes(s);

/** The tab just started waiting for the person (the moment to alert, once). */
export function entersNeedsYou(prev: TabState | null | undefined, next: TabState | null | undefined): boolean {
  return !waiting(prev) && waiting(next);
}

/** How many tabs of each project are waiting for the person; projects with none are absent. */
export function needsYouByProject(items: MonitorItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { tab } of items) {
    if (waiting(tab.state)) counts.set(tab.project_id, (counts.get(tab.project_id) ?? 0) + 1);
  }
  return counts;
}

/** Colour of the tab's status dot: orange while the tool waits for the person. */
export function tabDotClass(alive: boolean, state: TabState | null | undefined): string {
  if (waiting(state)) return 'animate-pulse bg-attention';
  if (state === 'error') return 'bg-danger';
  return alive ? 'bg-ok' : 'bg-fg-dim';
}

/** What the alert says: the tool's own message, or a line for the state. */
export function needsYouText(tab: Tab): string {
  if (tab.state_text) return tab.state_text;
  return tab.state === 'waiting_permission' ? 'está pedindo permissão' : 'terminou e está esperando você';
}
