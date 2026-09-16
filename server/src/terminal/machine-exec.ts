import { execFile } from 'node:child_process';
import { config } from '../config.js';
import type { Machine } from '../db/repositories/types.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Escapa para uso dentro de aspas simples no shell remoto. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SESSION_RE = /^[A-Za-z0-9_-]+$/;
export function assertSessionName(name: string): void {
  if (!SESSION_RE.test(name)) throw new Error(`Nome de sessão tmux inválido: ${name}`);
}

export function sshBaseArgs(machine: Machine, connectTimeout = 5): string[] {
  if (machine.type !== 'ssh' || !machine.host) throw new Error('Máquina não é SSH');
  const target = machine.ssh_user ? `${machine.ssh_user}@${machine.host}` : machine.host;
  return [
    '-p',
    String(machine.ssh_port || 22),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeout}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    target,
  ];
}

/**
 * Executa um comando (sem PTY) na máquina. Para "ssh", o comando é uma string
 * interpretada pelo shell remoto; para "local", executa tmux diretamente com args.
 */
export function runOnMachine(
  machine: Machine,
  local: { file: string; args: string[] },
  remoteCommand: string,
  timeoutMs = 8000,
): Promise<ExecResult> {
  const [file, args] =
    machine.type === 'local' ? [local.file, local.args] : ['ssh', [...sshBaseArgs(machine), '--', remoteCommand]];

  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: !!e?.killed || e?.signal === 'SIGTERM',
      });
    });
  });
}

const tmux = () => config.terminal.tmuxPath;

export interface MachineStatus {
  online: boolean;
  tmux: boolean;
}

/** Testa conectividade e se o tmux está disponível na máquina. */
export async function machineStatus(machine: Machine): Promise<MachineStatus> {
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['-V'] },
    'command -v tmux >/dev/null 2>&1 && echo TERMHUB_TMUX_OK; exit 0',
    7000,
  );
  if (machine.type === 'local') return { online: true, tmux: r.code === 0 };
  return { online: r.code === 0, tmux: r.code === 0 && r.stdout.includes('TERMHUB_TMUX_OK') };
}

/** Lista as sessões tmux ativas na máquina (vazio se o servidor tmux não está rodando). */
export async function listTmuxSessions(machine: Machine): Promise<Set<string>> {
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['list-sessions', '-F', '#{session_name}'] },
    `tmux list-sessions -F '#{session_name}' 2>/dev/null || true`,
  );
  const set = new Set<string>();
  if (r.code !== 0) return set;
  for (const line of r.stdout.split('\n')) {
    const name = line.trim();
    if (name) set.add(name);
  }
  return set;
}

export async function killTmuxSession(machine: Machine, session: string): Promise<boolean> {
  assertSessionName(session);
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['kill-session', '-t', `=${session}`] },
    `tmux kill-session -t '=${session}' 2>/dev/null || true`,
  );
  return r.code === 0;
}
