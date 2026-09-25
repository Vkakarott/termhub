import net from 'node:net';
import type { TcpOpenParams } from '@termhub/agent-protocol';
import { isWdaPort } from '@termhub/agent-protocol';
import type { AgentSocket } from './client.js';
import type { TcpManager } from './dispatch.js';

export interface TcpManagerDeps {
  log: (msg: string, meta?: object) => void;
  /** Which ports may be reached. Defaults to the WDA ranges (`isWdaPort`); tests inject `() => true`. */
  allowPort?: (port: number) => boolean;
  /** Pause reading the local socket when the WebSocket has this many bytes queued. Default 4 MiB. */
  highWater?: number;
  /** Resume once the queue is back under this. Default 1 MiB. */
  lowWater?: number;
  /** How often to re-check the queue while paused. Default 50 ms. */
  resumePollMs?: number;
}

interface Channel {
  sock: net.Socket;
  paused: boolean;
  resumeTimer: ReturnType<typeof setInterval> | null;
  /** Set by close()/closeAll(): the server dropped its side; nothing more is forwarded or acked. */
  closed: boolean;
  sendClosed(reason?: 'reset'): void;
}

const DEFAULT_HIGH_WATER = 4 * 1024 * 1024;
const DEFAULT_LOW_WATER = 1024 * 1024;
const DEFAULT_RESUME_POLL_MS = 50;

function isRefused(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED';
}

/**
 * Raw TCP pipes to loopback ports on this machine (the WDA runner's HTTP and MJPEG ports), one per
 * channel. Same shape as the PTY and Claude managers so `dispatch.ts` only routes by kind. Flow
 * control: when the WebSocket queue passes `highWater`, the local socket is paused, which pushes the
 * pressure back to the local server (WDA holds frames) instead of growing this process's memory or
 * starving the terminals that share the socket.
 */
export function createTcpManager(deps: TcpManagerDeps): TcpManager & { isPaused(ch: number): boolean } {
  const channels = new Map<number, Channel>();
  const allowPort = deps.allowPort ?? isWdaPort;
  const highWater = deps.highWater ?? DEFAULT_HIGH_WATER;
  const lowWater = deps.lowWater ?? DEFAULT_LOW_WATER;
  const resumePollMs = deps.resumePollMs ?? DEFAULT_RESUME_POLL_MS;

  const control = (socket: AgentSocket, msg: Parameters<AgentSocket['sendControl']>[0]) => {
    try {
      socket.sendControl(msg);
    } catch (err) {
      deps.log('tcp control send failed', { type: msg.type, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const stopResumeTimer = (entry: Channel) => {
    if (entry.resumeTimer) clearInterval(entry.resumeTimer);
    entry.resumeTimer = null;
  };

  const drop = (ch: number, entry: Channel) => {
    entry.closed = true;
    stopResumeTimer(entry);
    if (channels.get(ch) === entry) channels.delete(ch);
    entry.sock.destroy();
  };

  return {
    async open(ch, params: TcpOpenParams, socket: AgentSocket): Promise<void> {
      if (channels.has(ch)) {
        control(socket, { type: 'open_error', ch, error: { code: 'invalid', message: 'channel in use' } });
        return;
      }
      if (!allowPort(params.port)) {
        deps.log('tcp open refused: port not allowed', { ch, port: params.port });
        control(socket, { type: 'open_error', ch, error: { code: 'invalid', message: 'port not allowed' } });
        return;
      }

      const sock = net.connect({ host: '127.0.0.1', port: params.port });
      let opened = false;
      let closedSent = false;
      const entry: Channel = {
        sock,
        paused: false,
        resumeTimer: null,
        closed: false,
        sendClosed: (reason) => {
          if (closedSent) return;
          closedSent = true;
          control(socket, reason ? { type: 'closed', ch, code: null, reason } : { type: 'closed', ch, code: null });
        },
      };
      channels.set(ch, entry);

      await new Promise<void>((resolve) => {
        sock.once('connect', () => {
          opened = true;
          deps.log('tcp opened', { ch, port: params.port });
          control(socket, { type: 'opened', ch });
          resolve();
        });
        sock.once('error', (err: NodeJS.ErrnoException) => {
          if (!opened) {
            // Failed before connecting: the server never sees `opened`, so it gets open_error, not closed.
            channels.delete(ch);
            stopResumeTimer(entry);
            deps.log('tcp open failed', { ch, port: params.port, code: err.code ?? 'unknown' });
            control(socket, { type: 'open_error', ch, error: isRefused(err) ? { code: 'refused', message: 'connection refused' } : { code: 'internal', message: 'connect failed' } });
            resolve();
            return;
          }
          // Errored after connecting: reported by the 'close' handler below as reason 'reset'.
          deps.log('tcp socket error', { ch, port: params.port, code: err.code ?? 'unknown' });
          entry.sock.destroy();
        });
      });
      if (!channels.has(ch)) return; // open failed above

      sock.on('data', (chunk: Buffer) => {
        if (entry.closed) return;
        try {
          socket.sendStream(ch, chunk);
        } catch (err) {
          deps.log('tcp stream send failed', { ch, error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const queued = socket.bufferedAmount?.() ?? 0;
        if (queued > highWater && !entry.paused) {
          entry.paused = true;
          sock.pause();
          deps.log('tcp paused', { ch, queued });
          entry.resumeTimer = setInterval(() => {
            if (entry.closed) {
              stopResumeTimer(entry);
              return;
            }
            if ((socket.bufferedAmount?.() ?? 0) <= lowWater) {
              stopResumeTimer(entry);
              entry.paused = false;
              sock.resume();
              deps.log('tcp resumed', { ch });
            }
          }, resumePollMs);
        }
      });
      sock.on('close', (hadError: boolean) => {
        if (!opened) return; // a refused connect already answered open_error above
        stopResumeTimer(entry);
        if (channels.get(ch) === entry) channels.delete(ch);
        if (entry.closed) return; // close()/closeAll() already handled it
        deps.log('tcp closed', { ch, port: params.port, hadError });
        entry.sendClosed(hadError ? 'reset' : undefined);
      });
    },

    write(ch, data): boolean {
      const entry = channels.get(ch);
      if (!entry || entry.closed) return false;
      entry.sock.write(data);
      return true;
    },

    close(ch): void {
      const entry = channels.get(ch);
      if (!entry) return;
      drop(ch, entry);
      // Always ack: the server keeps the number reserved until it sees `closed`.
      entry.sendClosed();
    },

    closeAll(): void {
      for (const [ch, entry] of channels) drop(ch, entry);
    },

    isPaused(ch): boolean {
      return channels.get(ch)?.paused ?? false;
    },
  };
}
