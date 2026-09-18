import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { NEEDS_YOU, type MonitorItem, type Tab } from './types';

interface MonitorState {
  /** every tab in the scope with a reported state, newest change first */
  items: MonitorItem[];
  /** tabs whose tool is waiting for the person */
  needsYou: MonitorItem[];
  /** monitor state of one tab (live), or undefined when it never reported */
  tabState: (tabId: string) => Tab | undefined;
  /** types the text into the tab (Enter included) and marks it working */
  reply: (tabId: string, text: string) => Promise<void>;
  reload: () => Promise<void>;
  connected: boolean;
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
      needsYou: items.filter((i) => i.tab.state && NEEDS_YOU.includes(i.tab.state)),
      tabState: (tabId) => itemsRef.current.find((i) => i.tab.id === tabId)?.tab,
      async reply(tabId, text) {
        const r = await api.tabs.input(tabId, text, true);
        setItems((list) => list.map((i) => (i.tab.id === tabId ? { ...i, tab: { ...i.tab, ...r.tab } } : i)));
      },
      reload,
      connected,
    }),
    [items, reload, connected],
  );

  return <MonitorContext.Provider value={value}>{children}</MonitorContext.Provider>;
}

export function useMonitor(): MonitorState {
  const ctx = useContext(MonitorContext);
  if (!ctx) throw new Error('useMonitor fora do MonitorProvider');
  return ctx;
}
