import { execFile, spawn } from 'node:child_process';
import { config } from '../config.js';
import type { Machine } from '../db/repositories/types.js';
import { DETECT_SCRIPT, REMOTE_PATH_PREFIX, assertSessionName, parseDetect } from '@termhub/machine-ops';
import { agentRpc, toHttpError } from '../agent/errors.js';
import { AgentOfflineError, agents } from '../agent/registry.js';

export { DETECT_TOOLS, REMOTE_PATH_PREFIX, assertSessionName, shellQuote } from '@termhub/machine-ops';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function sshBaseArgs(machine: Machine, connectTimeout = 5): string[] {
  if (machine.type === 'agent') throw new Error('Máquina do tipo agente não executa shell');
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
  if (machine.type === 'agent') throw new Error('Máquina do tipo agente não executa shell');
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

/**
 * Como runOnMachine, mas envia `input` pelo stdin do processo (local ou do ssh).
 * Usado para copiar arquivos para a máquina sem depender de scp.
 */
export function runOnMachineWithInput(
  machine: Machine,
  local: { file: string; args: string[] },
  remoteCommand: string,
  input: Buffer,
  timeoutMs = 30000,
): Promise<ExecResult> {
  if (machine.type === 'agent') throw new Error('Máquina do tipo agente não executa shell');
  const [file, args] =
    machine.type === 'local' ? [local.file, local.args] : ['ssh', [...sshBaseArgs(machine, 10), '--', remoteCommand]];

  return new Promise((resolve) => {
    const child = spawn(file, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    };
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {
      /* EPIPE se o remoto fechar antes: 'close' reporta o código */
    });
    child.stdin.end(input);
  });
}

const tmux = () => config.terminal.tmuxPath;

export interface MachineStatus {
  online: boolean;
  tmux: boolean;
  os: string | null;
  /** ferramentas encontradas no PATH de login: claude, gh, git, node, xcodebuild, ... */
  capabilities: string[];
}

/** Testa conectividade, tmux, SO e ferramentas disponíveis na máquina. */
export async function machineStatus(machine: Machine): Promise<MachineStatus> {
  // Agent: status comes from the registry's own connection state, never a shell exec.
  if (machine.type === 'agent') {
    const info = agents.info(machine.id);
    return { online: agents.isOnline(machine.id), tmux: info?.tools.includes('tmux') ?? false, os: machine.os, capabilities: machine.capabilities };
  }
  // Local: roda via shell de login para ter o PATH do usuário (claude em ~/.local/bin, brew...)
  const r = await runOnMachine(
    machine,
    { file: '/bin/sh', args: ['-lc', DETECT_SCRIPT] },
    // Remoto: o ssh já usa shell de login; garante ~/.local/bin e brew no PATH
    `${REMOTE_PATH_PREFIX}${DETECT_SCRIPT}`,
    8000,
  );
  const online = machine.type === 'local' || r.code === 0;
  const det = online ? parseDetect(r.stdout) : { os: null, capabilities: [] };
  return { online, tmux: det.capabilities.includes('tmux'), ...det };
}

/** Lista as sessões tmux ativas na máquina (vazio se o servidor tmux não está rodando). */
export async function listTmuxSessions(machine: Machine): Promise<Set<string>> {
  if (machine.type === 'agent') {
    try {
      const { sessions } = await agents.rpc(machine.id, 'tmux.list', {});
      return new Set(sessions);
    } catch (err) {
      // Same behaviour as the shell path returning a non-zero exit: no sessions, no error.
      if (err instanceof AgentOfflineError) return new Set();
      throw toHttpError(err);
    }
  }
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['list-sessions', '-F', '#{session_name}'] },
    `${REMOTE_PATH_PREFIX}tmux list-sessions -F '#{session_name}' 2>/dev/null || true`,
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
  if (machine.type === 'agent') {
    const { killed } = await agentRpc(machine, 'tmux.kill', { session });
    return killed;
  }
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['kill-session', '-t', `=${session}`] },
    `${REMOTE_PATH_PREFIX}tmux kill-session -t '=${session}' 2>/dev/null || true`,
  );
  return r.code === 0;
}

