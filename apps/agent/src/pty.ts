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
export function createPtyManager(deps: PtyManagerDeps): PtyManager {
  const procs = new Map<number, PtyLike>();
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

      const { cols, rows } = clampSize(params);
      const cwd = resolveCwd(params.cwd);
      const env = {
        ...ptyEnv(agentEnv(), process.env.SHELL ?? '/bin/sh'),
        TERMHUB_TAB_ID: params.session,
        TERMHUB_SESSION: params.session,
      };

      let proc: PtyLike;
      try {
        const spawn = await resolveSpawn();
        proc = spawn(tmux, ['-u', 'new-session', '-A', '-s', params.session, '-c', cwd], { name: 'xterm-256color', cols, rows, cwd, env });
      } catch (err) {
        socket.sendControl({
          type: 'open_error',
          ch,
          error: isEnoent(err) ? { code: 'no_tmux', message: 'tmux not found' } : { code: 'internal', message: 'failed to start pty' },
        });
        return;
      }

      procs.set(ch, proc);
      deps.log('pty opened', { ch, session: params.session, cols, rows });

      proc.onData((data) => {
        socket.sendStream(ch, Buffer.from(data, 'utf8'));
      });
      proc.onExit(({ exitCode }) => {
        // If close() already deleted (or a later open() replaced) this entry, `closed` was
        // already sent — don't send it twice for the same channel.
        if (procs.get(ch) !== proc) return;
        procs.delete(ch);
        const code = exitCode ?? null;
        deps.log('pty exited', { ch, code });
        socket.sendControl({ type: 'closed', ch, code });
      });

      socket.sendControl({ type: 'opened', ch });
    },

    write(ch, data): void {
      const proc = procs.get(ch);
      if (!proc) return;
      proc.write(data.toString('utf8'));
    },

    resize(ch, cols, rows): void {
      const proc = procs.get(ch);
      if (!proc) return;
      const size = clampSize({ cols, rows });
      try {
        proc.resize(size.cols, size.rows);
      } catch {
        /* pty already exited */
      }
    },

    close(ch): void {
      const proc = procs.get(ch);
      if (!proc) return;
      // Delete before kill so the onExit handler (fired sync or async by the kill) sees the
      // channel as already closed and skips sending a second `closed`.
      procs.delete(ch);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },

    closeAll(): void {
      for (const [ch, proc] of procs) {
        procs.delete(ch);
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
