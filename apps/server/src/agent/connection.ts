import { EventEmitter } from 'node:events';
import {
  CLOSE,
  CONTROL_CHANNEL,
  MAX_CHANNELS,
  RPC,
  agentMessage,
  decodeFrame,
  encodeFrame,
  type HelloMessage,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type PtyOpenParams,
  type ServerMessage,
} from '@termhub/agent-protocol';

export interface SocketLike extends EventEmitter {
  send(data: Buffer, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  readyState: number;
}

export interface PtyHandlers {
  onData(data: Buffer): void;
  onExit(code: number | null): void;
}

export interface AgentPtyChannel {
  readonly ch: number;
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export type LoggerLike = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
};

export class AgentTimeoutError extends Error {}

export class AgentRpcError extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(rpcError.message);
  }
}

export class AgentClosedError extends Error {}

const HELLO_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 10_000;

interface PendingRpc {
  method: RpcMethod;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: unknown): void;
  reject(err: Error): void;
}

interface ChannelEntry {
  handlers: PtyHandlers;
  open: { resolve(ch: AgentPtyChannel): void; reject(err: Error): void } | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  /** Set when our local open timeout fired first: the number stays reserved (tombstoned)
   *  until the agent acknowledges with `closed`/`open_error`, so it can't be handed to a
   *  new openPty() while a stale `opened` for this attempt might still be in flight. */
  timedOut: boolean;
}

export class AgentConnection extends EventEmitter {
  readonly machineId: string;
  readonly connectedAt: number;
  hello: HelloMessage | null = null;

  private readonly socket: SocketLike;
  private readonly log: LoggerLike;
  private readonly now: () => number;

  private helloWaiters: { resolve(h: HelloMessage): void; reject(err: Error): void }[] = [];
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  private seq = 0;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly channels = new Map<number, ChannelEntry>();

  private alive = true;
  /** True as soon as a close has been initiated locally (close()/violation()) or the
   *  socket's 'close' event has fired — gates new rpc()/openPty() calls and incoming
   *  frame processing immediately, without waiting for the (possibly async) 'close' event. */
  private closing = false;
  /** True once onClose()'s cleanup has fully run; guards that cleanup from running twice. */
  private closed = false;

  constructor(socket: SocketLike, opts: { machineId: string; log: LoggerLike; now?: () => number }) {
    super();
    this.socket = socket;
    this.machineId = opts.machineId;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.connectedAt = this.now();

    this.socket.on('message', (data: Buffer) => this.onMessage(data));
    this.socket.on('close', (code: number, reason: Buffer) => this.onClose(code, reason?.toString() ?? ''));
    this.socket.on('pong', () => (this.alive = true));
    this.socket.on('error', (err: Error) => this.log.error({ machineId: this.machineId, err: err.message }, 'agent socket error'));
  }

  waitHello(timeoutMs = HELLO_TIMEOUT_MS): Promise<HelloMessage> {
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise((resolve, reject) => {
      this.helloWaiters.push({ resolve, reject });
      if (!this.helloTimer) {
        this.helloTimer = setTimeout(() => {
          this.violation('hello timeout');
        }, timeoutMs);
      }
    });
  }

  rpc<M extends RpcMethod>(method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>> {
    if (this.closing) {
      return Promise.reject(new AgentClosedError('agent connection closed'));
    }
    const id = `r${++this.seq}`;
    const effectiveTimeout = timeoutMs ?? RPC[method].timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentTimeoutError(`agent rpc timeout: ${method}`));
      }, effectiveTimeout);
      this.pending.set(id, {
        method,
        startedAt: this.now(),
        timer,
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      this.sendControl({ type: 'rpc', id, method, params });
    });
  }

  openPty(params: PtyOpenParams, handlers: PtyHandlers): Promise<AgentPtyChannel> {
    if (this.closing) {
      return Promise.reject(new AgentClosedError('agent connection closed'));
    }
    if (this.channels.size >= MAX_CHANNELS) {
      return Promise.reject(new Error('too many channels'));
    }
    const ch = this.nextChannel();
    return new Promise((resolve, reject) => {
      const entry: ChannelEntry = { handlers, open: null, openTimer: null, timedOut: false };
      const timer = setTimeout(() => {
        // We gave up locally, but the agent may still reply to the original 'open' — keep
        // the channel number reserved (tombstoned) and tell the agent to close it, instead
        // of freeing the number for a late 'opened'/'open_error' to land on a new request.
        entry.timedOut = true;
        entry.open = null;
        entry.openTimer = null;
        this.sendControl({ type: 'close', ch });
        reject(new AgentTimeoutError(`agent open timeout: ch ${ch}`));
      }, OPEN_TIMEOUT_MS);
      entry.openTimer = timer;
      entry.open = {
        resolve: (channel: AgentPtyChannel) => {
          clearTimeout(timer);
          entry.open = null;
          entry.openTimer = null;
          resolve(channel);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.channels.delete(ch);
          reject(err);
        },
      };
      this.channels.set(ch, entry);
      this.sendControl({ type: 'open', ch, kind: 'pty', params });
    });
  }

  close(code: number, reason?: string): void {
    this.closing = true;
    this.socket.close(code, reason);
  }

  heartbeat(): void {
    if (!this.alive) {
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  // --- internals ---

  private nextChannel(): number {
    for (let ch = 1; ch <= MAX_CHANNELS; ch++) {
      if (!this.channels.has(ch)) return ch;
    }
    throw new Error('too many channels');
  }

  private sendControl(msg: ServerMessage): void {
    this.socket.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(msg)));
  }

  private violation(reason: string): void {
    this.closing = true;
    this.log.warn({ machineId: this.machineId, reason }, 'agent protocol violation');
    for (const w of this.helloWaiters) w.reject(new Error(`protocol violation: ${reason}`));
    this.helloWaiters = [];
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    this.socket.close(CLOSE.VIOLATION, reason);
  }

  private onMessage(data: Buffer): void {
    if (this.closing) return;
    let frame: { ch: number; payload: Buffer };
    try {
      frame = decodeFrame(data);
    } catch {
      this.violation('malformed frame');
      return;
    }

    if (frame.ch === CONTROL_CHANNEL) {
      this.onControl(frame.payload);
      return;
    }

    if (!this.hello) {
      this.violation('stream frame before hello');
      return;
    }

    const entry = this.channels.get(frame.ch);
    if (!entry) {
      this.violation(`unknown channel ${frame.ch}`);
      return;
    }
    entry.handlers.onData(frame.payload);
  }

  private onControl(payload: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      this.violation('malformed control json');
      return;
    }
    const parsed = agentMessage.safeParse(json);
    if (!parsed.success) {
      this.violation('invalid control message');
      return;
    }
    const msg = parsed.data;

    if (!this.hello) {
      if (msg.type !== 'hello') {
        this.violation('expected hello');
        return;
      }
      this.hello = msg;
      if (this.helloTimer) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
      }
      const waiters = this.helloWaiters;
      this.helloWaiters = [];
      for (const w of waiters) w.resolve(msg);
      return;
    }

    switch (msg.type) {
      case 'hello':
        // Ignore a repeated hello after the handshake; not a violation.
        return;
      case 'rpc_result':
        this.onRpcResult(msg);
        return;
      case 'opened':
        this.onOpened(msg.ch);
        return;
      case 'open_error':
        this.onOpenError(msg.ch, msg.error);
        return;
      case 'closed':
        this.onChannelClosed(msg.ch, msg.code);
        return;
    }
  }

  private onRpcResult(msg: { id: string; ok: boolean; result?: unknown; error?: RpcError }): void {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      this.log.debug?.({ machineId: this.machineId, id: msg.id }, 'rpc result for unknown id');
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    const ms = this.now() - entry.startedAt;

    if (msg.ok) {
      const resultSchema = RPC[entry.method].result;
      const validated = resultSchema.safeParse(msg.result);
      if (!validated.success) {
        entry.reject(new Error(`invalid rpc result for ${entry.method}`));
        return;
      }
      this.log.info({ machineId: this.machineId, method: entry.method, ms }, 'agent rpc completed');
      entry.resolve(validated.data);
      return;
    }

    if (!msg.error) {
      // The pending entry is already removed from `this.pending`, so onClose()'s cleanup
      // loop can no longer find it — reject it here or the original caller's promise would
      // never settle.
      entry.reject(new Error(`protocol violation: rpc_result not ok without error for ${entry.method}`));
      this.violation('rpc_result not ok without error');
      return;
    }
    this.log.info({ machineId: this.machineId, method: entry.method, ms, ok: false }, 'agent rpc completed');
    entry.reject(new AgentRpcError(msg.error));
  }

  private onOpened(ch: number): void {
    const entry = this.channels.get(ch);
    if (!entry) {
      this.violation(`opened for unknown channel ${ch}`);
      return;
    }
    if (entry.timedOut) {
      // Late reply to a request we already gave up on locally: tell the agent (again) to
      // close it and ignore — not a violation, the agent just raced our local timeout.
      this.sendControl({ type: 'close', ch });
      return;
    }
    if (!entry.open) {
      this.violation(`opened for unknown channel ${ch}`);
      return;
    }
    const channel = this.buildChannel(ch);
    entry.open.resolve(channel);
  }

  private onOpenError(ch: number, error: RpcError): void {
    const entry = this.channels.get(ch);
    if (!entry) {
      this.violation(`open_error for unknown channel ${ch}`);
      return;
    }
    if (entry.timedOut) {
      // The agent acknowledged the close we sent after our local timeout: free the number.
      this.channels.delete(ch);
      return;
    }
    if (!entry.open) {
      this.violation(`open_error for unknown channel ${ch}`);
      return;
    }
    entry.open.reject(new AgentRpcError(error));
  }

  private onChannelClosed(ch: number, code: number | null): void {
    const entry = this.channels.get(ch);
    if (!entry) {
      this.violation(`closed for unknown channel ${ch}`);
      return;
    }
    if (entry.timedOut) {
      // The agent acknowledged the close we sent after our local timeout: free the number.
      this.channels.delete(ch);
      return;
    }
    if (entry.open) {
      // The agent closed the pty before ever confirming it opened: settle the openPty()
      // promise as a failure, never as an exit — the caller never got a channel object.
      if (entry.openTimer) clearTimeout(entry.openTimer);
      this.channels.delete(ch);
      entry.open.reject(new Error('pty closed before opened'));
      return;
    }
    this.channels.delete(ch);
    entry.handlers.onExit(code);
  }

  private buildChannel(ch: number): AgentPtyChannel {
    return {
      ch,
      write: (data: Buffer | string) => {
        this.socket.send(encodeFrame(ch, data));
      },
      resize: (cols: number, rows: number) => {
        this.sendControl({ type: 'resize', ch, cols, rows });
      },
      close: () => {
        this.sendControl({ type: 'close', ch });
        this.channels.delete(ch);
      },
    };
  }

  private onClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;

    for (const w of this.helloWaiters) w.reject(new AgentClosedError('agent connection closed'));
    this.helloWaiters = [];
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new AgentClosedError('agent connection closed'));
    }
    this.pending.clear();

    for (const entry of this.channels.values()) {
      if (entry.openTimer) clearTimeout(entry.openTimer);
      if (entry.timedOut) {
        // Already settled (rejected) locally when the open timeout fired; nothing to notify.
        continue;
      }
      if (entry.open) {
        entry.open.reject(new AgentClosedError('agent connection closed'));
      } else {
        entry.handlers.onExit(null);
      }
    }
    this.channels.clear();

    this.emit('close', code, reason);
  }
}
