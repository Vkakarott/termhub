import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { entersNeedsYou, optimisticSeenAt, shouldMarkSeen, tabNeedsYou } from './needs-you';
import type { MonitorItem, Tab } from './types';

/** Called when a push moves a tab into a waiting state (never for the snapshot on load). */
export type NeedsYouListener = (tab: Tab, projectId: string) => void;

interface MonitorState {
  /** every tab in the scope with a reported state, newest change first */
  items: MonitorItem[];
  /** tabs that need you: waiting and not seen since */
  needsYou: MonitorItem[];
  /** monitor state of one tab (live), or undefined when it never reported */
  tabState: (tabId: string) => Tab | undefined;
  /** types the text into the tab (Enter included) and marks it working */
  reply: (tabId: string, text: string) => Promise<void>;
  /** the user just looked at this tab: optimistically clears its "needs you" dot, then confirms with the server */
  markSeen: (tabId: string) => Promise<void>;
  reload: () => Promise<void>;
  connected: boolean;
  /** subscribes to tabs that start needing you; returns the unsubscribe */
  onNeedsYou: (listener: NeedsYouListener) => () => void;
}

const MonitorContext = createContext<MonitorState | null>(null);

const RECONNECT_MS = 5_000;
/** the snapshot is re-read on reconnect and every few minutes, in case a push was missed */
const RESYNC_MS = 3 * 60_000;

/**
 * Snapshot over REST + pushes over /ws/monitor. Feeds the home "precisando de você" list and
 * the tab bar dots. Only the tool's own message travels here, never terminal content.
 */
export function MonitorProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<MonitorItem[]>([]);
  const [connected, setConnected] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const listeners = useRef(new Set<NeedsYouListener>());
  const onNeedsYou = useCallback((listener: NeedsYouListener) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await api.monitor.tabs();
      setItems(r.items);
    } catch {
      /* keeps the last snapshot; the next resync retries */
    }
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const open = () => {
      if (stopped) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/monitor`);
      ws.onopen = () => {
        setConnected(true);
        void reload();
      };
      ws.onmessage = (ev) => {
        let msg: { type?: string; tab?: Tab; project_id?: string; machine_id?: string };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type !== 'tab' || !msg.tab) return;
        const tab = msg.tab;
        // compared with what was on screen before this push (a tab never seen counts as not needing you)
        const prev = itemsRef.current.find((i) => i.tab.id === tab.id)?.tab;
        if (entersNeedsYou(prev, tab)) {
          const projectId = msg.project_id ?? tab.project_id;
          listeners.current.forEach((l) => l(tab, projectId));
        }
        setItems((list) => {
          const idx = list.findIndex((i) => i.tab.id === tab.id);
          if (idx === -1) {
            // a tab we had not seen (created after the snapshot): the resync fills project/machine
            void reload();
            return list;
          }
          const next = list.slice();
          next[idx] = { ...list[idx], tab: { ...list[idx].tab, ...tab } };
          next.sort((a, b) => (b.tab.state_at ?? '').localeCompare(a.tab.state_at ?? ''));
          return next;
        });
      };
      ws.onclose = () => {
        setConnected(false);
        ws = null;
        if (!stopped) timer = setTimeout(open, RECONNECT_MS);
      };
      ws.onerror = () => ws?.close();
    };
    void reload();
    open();
    const resync = setInterval(() => void reload(), RESYNC_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(resync);
      ws?.close();
    };
  }, [reload]);

  const value = useMemo<MonitorState>(
    () => ({
      items,
      needsYou: items.filter((i) => tabNeedsYou(i.tab)),
      tabState: (tabId) => itemsRef.current.find((i) => i.tab.id === tabId)?.tab,
      async reply(tabId, text) {
        const r = await api.tabs.input(tabId, text, true);
        setItems((list) => list.map((i) => (i.tab.id === tabId ? { ...i, tab: { ...i.tab, ...r.tab } } : i)));
      },
      async markSeen(tabId) {
        // Optimistic: the WS push from the server confirms it (and syncs every other device).
        // optimisticSeenAt never goes earlier than the tab's own state_at, so a browser clock
        // running behind the server can't write a seen time that still reads as "unseen".
        const current = itemsRef.current.find((i) => i.tab.id === tabId)?.tab;
        const seenAt = optimisticSeenAt({ state_at: current?.state_at ?? null });
        setItems((list) => list.map((i) => (i.tab.id === tabId ? { ...i, tab: { ...i.tab, state_seen_at: seenAt } } : i)));
        try {
          await api.tabs.seen(tabId);
        } catch {
          void reload(); // never leave a stale optimistic write on screen
        }
      },
      reload,
      connected,
      onNeedsYou,
    }),
    [items, reload, connected, onNeedsYou],
  );

  return <MonitorContext.Provider value={value}>{children}</MonitorContext.Provider>;
}

export function useMonitor(): MonitorState {
  const ctx = useContext(MonitorContext);
  if (!ctx) throw new Error('useMonitor fora do MonitorProvider');
  return ctx;
}

/**
 * Marks the focused tab seen (clears its "needs you" dot) as soon as the person is actually
 * looking at it: they can (`terminals:update` — no point in an optimistic clear that just 403s
 * and bounces back on reload), the terminals view is visible, this tab is focused, and the
 * browser window itself is visible and focused (not just another app on top). Re-checks on focus
 * changes, on a monitor push for this tab (a new needs-you event while looking at it re-arms it),
 * and on the window regaining focus/visibility — `shouldMarkSeen` (needs-you.ts) makes the call;
 * `markSeen` (above) fires at most once per (tab id, state_at) via its own dedupe below.
 */
export function useMarkSeenOnFocus(tabId: string | null, viewVisible: boolean): void {
  const { tabState, markSeen } = useMonitor();
  const { can } = useAuth();
  const canMark = can('terminals', 'update');
  const askedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!tabId || !canMark) return;
    const check = () => {
      const tab = tabState(tabId);
      if (!tab) return;
      const windowActive = document.visibilityState === 'visible' && document.hasFocus();
      if (!shouldMarkSeen(tab, { viewVisible, windowActive, canMark })) return;
      const key = `${tabId}:${tab.state_at}`;
      if (askedRef.current === key) return;
      askedRef.current = key;
      void markSeen(tabId);
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [tabId, viewVisible, canMark, tabState, markSeen]);
}
