import fs from 'node:fs';
import path from 'node:path';
import { clampSize, ptyEnv } from '@termhub/machine-ops';
import type { PtyOpenParams } from '@termhub/agent-protocol';
import type { AgentSocket } from './client.js';
import type { PtyManager } from './dispatch.js';
import { agentEnv, tmuxPath } from './exec.js';

/**
 * The slice of node-pty's `IPty` this module actually uses. Kept narrow (rather than importing
 * `IPty` itself) so tests can inject a fake process without pulling in node-pty's native module —
 * `IPty` is a structural supertype of this, so the real `pty.spawn` still satisfies `SpawnFn`.
 */
export interface PtyLike {
  pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => PtyLike;

export interface PtyManagerDeps {
  /** Defaults to node-pty's `spawn`, imported lazily so tests never load the native module. */
  spawn?: SpawnFn;
  tmuxPath?: string;
  log: (msg: string, meta?: object) => void;
}

/** `~` / `~/…` expanded against `HOME`; anything else passed through unchanged. */
function expandHome(rawCwd: string, home: string): string {
  if (rawCwd === '~') return home;
  if (rawCwd.startsWith('~/')) return path.join(home, rawCwd.slice(2));
  return rawCwd;
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves the tmux `-c` / spawn cwd: the requested dir if it exists (after `~` expansion), else HOME. */
function resolveCwd(rawCwd: string): string {
  const home = process.env.HOME || '/';
  const expanded = expandHome(rawCwd, home);
  return existsDir(expanded) ? expanded : home;
}

function isEnoent(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e?.code === 'ENOENT') return true;
  const message = e instanceof Error ? e.message : String(err);
  return /ENOENT/.test(message);
}

/**
 * Attaches PTY channels to tmux sessions on this machine, mirroring the server's local spawn
 * (`apps/server/src/terminal/pty-session.ts`'s `local` branch of `buildSpawn`): same argv
 * (`-u new-session -A -s <session> -c <cwd>`), same UTF-8 env, same HOME cwd fallback.
 */
interface ChannelProc {
  proc: PtyLike;
  /** Set (before the kill) by close()/closeAll(): output the pty still emits is dropped. */
  closed: boolean;
  /** Sends `closed` to the server at most once, whichever of close()/onExit gets there first. */
  sendClosed(code: number | null): void;
}

export function createPtyManager(deps: PtyManagerDeps): PtyManager {
  const procs = new Map<number, ChannelProc>();
  const tmux = deps.tmuxPath ?? tmuxPath();
  let spawnFn: SpawnFn | undefined = deps.spawn;

  async function resolveSpawn(): Promise<SpawnFn> {
    if (!spawnFn) {
      const nodePty = await import('node-pty');
      spawnFn = nodePty.spawn as unknown as SpawnFn;
    }
    return spawnFn;
  }

  return {
    async open(ch, params: PtyOpenParams, socket: AgentSocket): Promise<void> {
      if (procs.has(ch)) {
        socket.sendControl({ type: 'open_error', ch, error: { code: 'invalid', message: 'channel in use' } });
        return;
      }

      // Everything that can throw before the PTY exists — size clamping, cwd resolution, env
      // building (`agentEnv()` can throw if `REMOTE_PATH_PREFIX` is ever malformed), resolving
      // the lazy `spawn` import, and the spawn call itself — stays inside this one try so no
      // exception can ever escape `open()` unreported.
      let proc: PtyLike;
      let cols: number;
      let rows: number;
      try {
        ({ cols, rows } = clampSize(params));
        const cwd = resolveCwd(params.cwd);
        const env = {
          ...ptyEnv(agentEnv(), process.env.SHELL ?? '/bin/sh'),
          TERMHUB_TAB_ID: params.session,
          TERMHUB_SESSION: params.session,
        };
        const spawn = await resolveSpawn();
        proc = spawn(tmux, ['-u', 'new-session', '-A', '-s', params.session, '-c', cwd], { name: 'xterm-256color', cols, rows, cwd, env });
      } catch (err) {
        // The wire message stays generic; the local log keeps the real reason (no PTY bytes here).
        deps.log('pty open failed', { ch, session: params.session, tmux, cwd: params.cwd, error: err instanceof Error ? err.message : String(err) });
        socket.sendControl({
          type: 'open_error',
          ch,
          error: isEnoent(err) ? { code: 'no_tmux', message: 'tmux not found' } : { code: 'internal', message: 'failed to start pty' },
        });
        return;
      }

      let closedSent = false;
      const entry: ChannelProc = {
        proc,
        closed: false,
        sendClosed: (code) => {
          if (closedSent) return;
          closedSent = true;
          try {
            socket.sendControl({ type: 'closed', ch, code });
          } catch (err) {
            deps.log('pty closed send failed', { ch, error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
      procs.set(ch, entry);
      deps.log('pty opened', { ch, session: params.session, cols, rows });

      proc.onData((data) => {
        // After close() the server has already dropped its side of the channel: whatever tmux
        // still emits on the way out ("[lost tty]", resets) must not be forwarded.
        if (entry.closed) return;
        try {
          socket.sendStream(ch, Buffer.from(data, 'utf8'));
        } catch (err) {
          deps.log('pty stream send failed', { ch, error: err instanceof Error ? err.message : String(err) });
        }
      });
      proc.onExit(({ exitCode }) => {
        // A later open() may have replaced this entry (close() already dropped it); only the
        // live entry owns the map slot. `closed` is deduped by sendClosed either way.
        if (procs.get(ch) === entry) procs.delete(ch);
        const code = exitCode ?? null;
        deps.log('pty exited', { ch, code });
        entry.sendClosed(code);
      });

      try {
        socket.sendControl({ type: 'opened', ch });
      } catch (err) {
        deps.log('pty opened send failed', { ch, error: err instanceof Error ? err.message : String(err) });
      }
    },

    write(ch, data): void {
      const entry = procs.get(ch);
      if (!entry) return;
      entry.proc.write(data.toString('utf8'));
    },

    resize(ch, cols, rows): void {
      const entry = procs.get(ch);
      if (!entry) return;
      const size = clampSize({ cols, rows });
      try {
        entry.proc.resize(size.cols, size.rows);
      } catch {
        /* pty already exited */
      }
    },

    close(ch): void {
      const entry = procs.get(ch);
      if (!entry) return;
      // Mark closed and drop the slot before the kill, so output/exit the kill triggers (sync
      // or async) is treated as the tail of this close, not as live traffic.
      entry.closed = true;
      procs.delete(ch);
      try {
        entry.proc.kill();
      } catch {
        /* ignore */
      }
      // Always ack: the server keeps the channel number reserved until it sees `closed`.
      // node-pty may report the exit later (or never, if the kill fails) — the ack must not
      // depend on it; sendClosed dedupes so the later onExit doesn't send a second one.
      entry.sendClosed(null);
    },

    closeAll(): void {
      // Session is over (socket gone): no acks to send, just stop forwarding and kill.
      for (const [ch, entry] of procs) {
        entry.closed = true;
        procs.delete(ch);
        try {
          entry.proc.kill();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
