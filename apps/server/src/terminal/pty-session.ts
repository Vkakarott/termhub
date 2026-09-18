import * as pty from 'node-pty';
import fs from 'node:fs';
import { UTF8_LOCALE, clampSize, ptyEnv } from '@termhub/machine-ops';
import { config } from '../config.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { agents } from '../agent/registry.js';
import { AgentPtySession } from '../agent/pty.js';
import { REMOTE_PATH_PREFIX, assertSessionName, shellQuote, sshBaseArgs } from './machine-exec.js';

export interface PtySize {
  cols: number;
  rows: number;
}

export interface PtySessionHandlers {
  onData: (data: string) => void;
  onExit: (code: number, signal?: number) => void;
}

/** A live PTY attached to a terminal tab, wherever it actually runs (local/ssh spawn or the user's agent). */
export interface PtySession {
  write(data: string | Buffer): void;
  resize(size: Partial<PtySize>): void;
  kill(): void;
  readonly pid: number | null;
}

function localCwd(cwd: string): string {
  try {
    return fs.statSync(cwd).isDirectory() ? cwd : process.env.HOME || '/';
  } catch {
    return process.env.HOME || '/';
  }
}

/** Monta o comando que anexa (ou cria) a sessão tmux da tab na máquina de destino. */
export function buildSpawn(machine: Machine, project: Project, tab: Tab): { file: string; args: string[]; cwd?: string } {
  if (tab.kind !== 'terminal' || !tab.tmux_session) throw new Error('Tab não é um terminal');
  assertSessionName(tab.tmux_session);
  if (machine.type === 'local') {
    return {
      file: config.terminal.tmuxPath,
      // -u: treat the client terminal as UTF-8 regardless of the locale tmux was started with
      args: ['-u', 'new-session', '-A', '-s', tab.tmux_session, '-c', localCwd(project.cwd)],
      cwd: localCwd(project.cwd),
    };
  }
  // PATH prefix: Homebrew's tmux is not on the sshd default PATH on macOS.
  // Locale: a non-interactive SSH session may come with no LANG at all (macOS), which makes
  // zsh and TUIs fall back to ASCII. Fix a UTF-8 locale, push it into a tmux server that is
  // already running (new windows inherit it), and attach with -u.
  const remote = [
    REMOTE_PATH_PREFIX.trim().replace(/;$/, ''),
    `export LANG="\${LANG:-${UTF8_LOCALE}}"; case "$LANG" in *[Uu][Tt][Ff]*) ;; *) LANG=${UTF8_LOCALE};; esac; export LC_ALL="$LANG" LC_CTYPE="$LANG"`,
    `tmux set-environment -g LANG "$LANG" 2>/dev/null; tmux set-environment -g LC_ALL "$LANG" 2>/dev/null`,
    `exec tmux -u new-session -A -s ${tab.tmux_session} -c ${shellQuote(project.cwd)}`,
  ].join('; ');
  return { file: 'ssh', args: ['-tt', ...sshBaseArgs(machine), remote] };
}

/** Um PTY por conexão WebSocket. O tmux na máquina de destino sobrevive ao PTY. */
export class LocalPtySession implements PtySession {
  private proc: pty.IPty;
  private closed = false;

  constructor(machine: Machine, project: Project, tab: Tab, size: Partial<PtySize>, handlers: PtySessionHandlers) {
    const { file, args, cwd } = buildSpawn(machine, project, tab);
    const { cols, rows } = clampSize(size);
    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd ?? process.env.HOME ?? '/',
      env: ptyEnv(process.env, config.terminal.localShell),
    });
    this.proc.onData(handlers.onData);
    this.proc.onExit(({ exitCode, signal }) => {
      this.closed = true;
      handlers.onExit(exitCode, signal);
    });
  }

  write(data: string | Buffer): void {
    if (this.closed) return;
    this.proc.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  resize(size: Partial<PtySize>): void {
    if (this.closed) return;
    const { cols, rows } = clampSize(size);
    try {
      this.proc.resize(cols, rows);
    } catch {
      /* pty já encerrado */
    }
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }

  get pid(): number {
    return this.proc.pid;
  }
}

/** Picks the right PtySession implementation for the tab's machine: local/ssh spawn a PTY here, `agent` opens one over the agent connection. */
export async function createPtySession(
  machine: Machine,
  project: Project,
  tab: Tab,
  size: Partial<PtySize>,
  handlers: PtySessionHandlers,
): Promise<PtySession> {
  if (machine.type === 'agent') {
    return AgentPtySession.open(agents, machine, project, tab, size, handlers);
  }
  return new LocalPtySession(machine, project, tab, size, handlers);
}
