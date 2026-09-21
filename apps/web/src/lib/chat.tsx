import { useEffect, useRef, useState } from 'react';
import type { ChatEvent } from './types';

const RECONNECT_MS = 5_000;

/**
 * Subscribes to /ws/chat. The socket carries no history, so `onReconnect` re-reads the
 * conversation over REST on every (re)connect — that is what makes a reconnect in the middle
 * of an answer safe: the page never needs a replay buffer, it just asks the server again.
 *
 * `onEvent` is called once for every event as it arrives, independent of the returned `events`
 * array: that array is capped (rendering only needs a recent window) and its length plateaus
 * once the cap is reached, so it must never be used to tell "already handled" from "new" — the
 * callback is the only reliable delivery point for that.
 */
export function useChatStream(onReconnect: () => void, onEvent: (event: ChatEvent) => void): { events: ChatEvent[]; connected: boolean } {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;
  const emit = useRef(onEvent);
  emit.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/chat`);
      ws.onopen = () => {
        setConnected(true);
        reconnect.current();
      };
      ws.onmessage = (ev) => {
        try {
          const event = JSON.parse(String(ev.data)) as ChatEvent;
          setEvents((prev) => [...prev.slice(-500), event]);
          emit.current(event);
        } catch {
          /* ignore a frame we cannot read */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        ws = null;
        if (!stopped) timer = setTimeout(open, RECONNECT_MS);
      };
      ws.onerror = () => ws?.close();
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { events, connected };
}
