export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'closed';

export interface TerminalConnectionHandlers {
  onData: (data: Uint8Array) => void;
  onState: (state: ConnectionState, attempt: number) => void;
  onExit?: (code: number) => void;
}

const MAX_ATTEMPTS = 8;
const BASE_DELAY = 500;
const MAX_DELAY = 15_000;

/**
 * WebSocket de um terminal com reconexão automática (backoff exponencial + jitter).
 * Binário = dados do terminal; texto = mensagens de controle em JSON.
 */
export class TerminalConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private size = { cols: 80, rows: 24 };
  private encoder = new TextEncoder();
  state: ConnectionState = 'connecting';

  constructor(
    private tabId: string,
    private handlers: TerminalConnectionHandlers,
  ) {}

  private setState(s: ConnectionState) {
    this.state = s;
    this.handlers.onState(s, this.attempt);
  }

  connect(size?: { cols: number; rows: number }) {
    if (size) this.size = size;
    this.stopped = false;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/tabs/${this.tabId}?cols=${this.size.cols}&rows=${this.size.rows}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('connected');
      this.sendResize(this.size.cols, this.size.rows);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.handlers.onData(new Uint8Array(ev.data));
        return;
      }
      try {
        const msg = JSON.parse(String(ev.data)) as { type: string; code?: number; message?: string };
        if (msg.type === 'exit') {
          this.handlers.onExit?.(msg.code ?? 0);
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      // 1000 = pty saiu (ex.: usuário digitou "exit" ou tmux detach) — reconecta para reanexar.
      // 1008/4001 = não autorizado — não insiste.
      if (ev.code === 1008 || ev.code === 4001) {
        this.setState('offline');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose cuida */
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.attempt >= MAX_ATTEMPTS) {
      this.setState('offline');
      return;
    }
    this.attempt += 1;
    const delay = Math.min(BASE_DELAY * 2 ** (this.attempt - 1), MAX_DELAY) * (0.7 + Math.random() * 0.6);
    this.setState('reconnecting');
    this.timer = setTimeout(() => this.open(), delay);
  }

  /** Reinicia o ciclo de tentativas (botão "reconectar" ou volta de foco/online). */
  retryNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.open();
  }

  send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.encoder.encode(data));
  }

  sendResize(cols: number, rows: number) {
    this.size = { cols, rows };
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
  }
}
