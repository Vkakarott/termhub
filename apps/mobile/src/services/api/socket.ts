// The `/ws/m/chat?v=1` client (design spec §4.1, P§6.1): a small state machine around a
// `Transport` socket. `socket.ts` never imports `react-native` — the foreground signal is
// injected (`foreground`), wired to `AppState` from the view layer in a later task, so this
// module stays testable under plain Node.
import { chatEventSchema, type TChatEvent } from './contract';
import type { Transport, TransportSocket } from './transport';

export interface CreateChatSocketOptions {
  transport: Transport;
  url: string;
  /** Builds fresh upgrade headers for every (re)connect, so a reconnect signs a new DPoP proof
   * (new `jti`, new `iat`) instead of replaying the first one. */
  headers(): Promise<Record<string, string>>;
  /** Every frame after `hello`, parsed with `chatEventSchema`. */
  onEvent(e: TChatEvent): void;
  /** Fires on every transport-level open, before `hello` arrives: the store re-reads `GET chat`
   * on every (re)connect (design spec §4.1 — no replay). */
  onReconnect(): void;
  /** `final` is true for the two terminal close codes (`4400`, `4401`): the socket is not
   * reopened. Any other code reconnects with backoff. */
  onClose(code: number, final: boolean): void;
  /** `hello.server_time` (ISO), fed into the client's clock-skew correction exactly like a
   * `Date` response header — the latest reading wins. */
  onServerTime(iso: string): void;
  backoff?: { min: number; max: number };
  /** Reconnects at once when the app comes to the foreground while disconnected. */
  foreground?: { subscribe(fn: () => void): () => void };
}

const DEFAULT_BACKOFF = { min: 1000, max: 30000 };

export function createChatSocket(o: CreateChatSocketOptions): { close(): void } {
  const backoff = o.backoff ?? DEFAULT_BACKOFF;

  let stopped = false;
  let connecting = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let socket: TransportSocket | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearTimer();
    const delay = Math.min(backoff.min * 2 ** attempt, backoff.max);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void open();
    }, delay);
  };

  async function open(): Promise<void> {
    if (stopped || socket !== null || connecting) return;
    connecting = true;
    let headers: Record<string, string>;
    try {
      headers = await o.headers();
    } catch {
      // Never surfaced as an unhandled rejection and never logged (it may carry key material):
      // treated exactly like a dropped connection, retried with the same backoff.
      connecting = false;
      if (!stopped) scheduleReconnect();
      return;
    }
    connecting = false;
    // `close()` may have run while `headers()` was in flight.
    if (stopped) return;

    let helloSeen = false;
    // Own to this one connection attempt, independent of `stopped`/`socket`: a real WebSocket's
    // `.close()` always fires that same socket's `onclose` again, later — including when *this*
    // module is the one calling `.close()` (the hello-violation branch below). Without this guard
    // that stale callback would land in the very same closure and re-report a close to the
    // consumer, run `scheduleReconnect()` a second time, or null out a newer connection that has
    // since replaced this one in `socket`.
    let abandoned = false;

    const abandonAndCloseTransport = () => {
      if (abandoned) return;
      abandoned = true;
      const dead = socket;
      socket = null;
      dead?.close();
    };

    socket = o.transport.connect(o.url, headers, {
      onOpen: () => {
        if (abandoned || stopped) return;
        // A successful open resets the backoff, whether or not `hello` follows.
        attempt = 0;
        o.onReconnect();
      },
      onMessage: (text) => {
        if (abandoned || stopped) return;
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        const result = chatEventSchema.safeParse(json);

        if (!helloSeen) {
          helloSeen = true;
          if (result.success && result.data.type === 'hello') {
            o.onServerTime(result.data.server_time);
            return;
          }
          // P§6.1: the server always sends `hello` first. Anything else there is a broken
          // connection — closed and retried like any other drop, never surfaced as a close code
          // since the server never actually asked to close.
          abandonAndCloseTransport();
          scheduleReconnect();
          return;
        }

        // Never fatal, and the content is never logged: an unparsable or schema-mismatched frame
        // is silently dropped, the connection stays up.
        if (!result.success) return;
        o.onEvent(result.data);
      },
      onClose: (code) => {
        if (abandoned) return;
        abandoned = true;
        socket = null;
        if (stopped) return;
        if (code === 4400 || code === 4401) {
          // Terminal: unknown protocol version or device revoked (P§6.1). No reconnect.
          o.onClose(code, true);
          return;
        }
        o.onClose(code, false);
        scheduleReconnect();
      },
    });
  }

  const unsubscribeForeground = o.foreground?.subscribe(() => {
    if (stopped || socket !== null || connecting) return;
    clearTimer();
    void open();
  });

  void open();

  return {
    close(): void {
      stopped = true;
      clearTimer();
      unsubscribeForeground?.();
      const dead = socket;
      socket = null;
      dead?.close();
    },
  };
}
