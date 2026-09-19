import { NEEDS_YOU, type MonitorItem, type Tab } from './types';

/** The tab fields the "needs you" rule reads (see server monitor/state.ts needsYou — same rule). */
type NeedsYouTab = Pick<Tab, 'state' | 'state_at' | 'state_seen_at'>;

/**
 * A tab "needs you" when its tool is waiting and it has not been seen since that state began:
 * `state_seen_at` is null or earlier than `state_at`. A new hook event bumps `state_at`, so a
 * seen tab needs you again automatically — no reset code needed.
 */
export function tabNeedsYou(tab: NeedsYouTab): boolean {
  if (!tab.state || !NEEDS_YOU.includes(tab.state) || !tab.state_at) return false;
  return !tab.state_seen_at || tab.state_seen_at < tab.state_at;
}

/** The tab just started needing you (the moment to alert, once); a re-armed tab (seen → new event) fires too. */
export function entersNeedsYou(prev: NeedsYouTab | null | undefined, next: NeedsYouTab | null | undefined): boolean {
  return !(prev && tabNeedsYou(prev)) && !!next && tabNeedsYou(next);
}

/** How many tabs of each project need you; projects with none are absent. */
export function needsYouByProject(items: MonitorItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { tab } of items) {
    if (tabNeedsYou(tab)) counts.set(tab.project_id, (counts.get(tab.project_id) ?? 0) + 1);
  }
  return counts;
}

/** Colour of the tab's status dot: orange while the tab needs you (waiting and not seen yet). */
export function tabDotClass(alive: boolean, tab: NeedsYouTab | null | undefined): string {
  if (tab && tabNeedsYou(tab)) return 'animate-pulse bg-attention';
  if (tab?.state === 'error') return 'bg-danger';
  return alive ? 'bg-ok' : 'bg-fg-dim';
}

/** What the alert says: the tool's own message, or a line for the state. */
export function needsYouText(tab: Tab): string {
  if (tab.state_text) return tab.state_text;
  return tab.state === 'waiting_permission' ? 'está pedindo permissão' : 'terminou e está esperando você';
}

/**
 * Whether to tell the server the person just looked at this tab: it needs you, and both the
 * terminals view (this tab focused, on screen) and the browser window are actually visible.
 * Pure so the effect (useMarkSeenOnFocus, in monitor.tsx/TerminalsView) stays a thin wrapper.
 */
export function shouldMarkSeen(tab: NeedsYouTab, opts: { viewVisible: boolean; windowActive: boolean }): boolean {
  return opts.viewVisible && opts.windowActive && tabNeedsYou(tab);
}
