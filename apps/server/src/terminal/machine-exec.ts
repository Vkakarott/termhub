import { execFile, spawn } from 'node:child_process';
import { config } from '../config.js';
import type { Machine } from '../db/repositories/types.js';
import { DETECT_SCRIPT, REMOTE_PATH_PREFIX, assertSessionName, parseDetect } from '@termhub/machine-ops';

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
  // Agent: no shell exec here; status comes from the agent's own connection (Task 8).
  if (machine.type === 'agent') return { online: false, tmux: false, os: null, capabilities: [] };
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
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['kill-session', '-t', `=${session}`] },
    `${REMOTE_PATH_PREFIX}tmux kill-session -t '=${session}' 2>/dev/null || true`,
  );
  return r.code === 0;
}

export type SshProblem = 'unreachable' | 'refused' | 'auth' | 'hostkey' | 'timeout' | 'no_tmux' | 'unknown';

export interface SshDiagnosis {
  ok: boolean;
  /** SSH login worked (tmux may still be missing) */
  connected: boolean;
  tmux: boolean;
  os: string | null;
  problem: SshProblem | null;
  /** what the user should do, in the UI language */
  hint: string | null;
  /** last line of ssh's stderr, for the curious */
  detail: string | null;
}

const HINTS: Record<SshProblem, string> = {
  refused: 'A máquina respondeu, mas nada escuta na porta SSH. Ligue o servidor SSH (macOS: Sessão Remota; Linux: openssh-server) e confira a porta.',
  unreachable: 'Não há rota até esse IP. Confira o endereço (macOS: ipconfig getifaddr en0; Linux: hostname -I) e se as duas máquinas estão na mesma rede.',
  timeout: 'A conexão não completou a tempo. IP errado, máquina dormindo ou firewall bloqueando a porta SSH.',
  auth: 'O servidor SSH aceitou a conexão, mas recusou a chave. Rode o comando do passo 3 na máquina, com o usuário informado aqui, e confira o nome do usuário.',
  hostkey: 'A chave do host mudou desde a última conexão (máquina reinstalada ou IP reaproveitado). Remova a entrada antiga do known_hosts no servidor do termhub.',
  no_tmux: 'Conectou, mas o tmux não está instalado (ou não está no PATH de login). Rode o passo 2.',
  unknown: 'Falha desconhecida; veja o detalhe.',
};

function classifySsh(stderr: string): SshProblem {
  const e = stderr.toLowerCase();
  if (e.includes('connection refused')) return 'refused';
  if (e.includes('no route to host') || e.includes('network is unreachable') || e.includes('could not resolve') || e.includes('name or service not known')) return 'unreachable';
  if (e.includes('timed out') || e.includes('connection timed out')) return 'timeout';
  if (e.includes('permission denied') || e.includes('too many authentication failures')) return 'auth';
  if (e.includes('host key verification failed') || e.includes('remote host identification has changed')) return 'hostkey';
  return 'unknown';
}

/** Tries an SSH login (BatchMode, no password) and explains what went wrong in user terms. */
export async function diagnoseSsh(target: { host: string; ssh_user: string | null; ssh_port: number }): Promise<SshDiagnosis> {
  const machine: Machine = {
    id: 'probe',
    name: 'probe',
    type: 'ssh',
    host: target.host,
    ssh_user: target.ssh_user,
    ssh_port: target.ssh_port,
    os: null,
    capabilities: [],
    checked_at: null,
    agent_version: null,
    agent_last_seen_at: null,
    owner_id: null,
    owner_name: null,
    created_at: '',
  };
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', 'exit 1'] }, `${REMOTE_PATH_PREFIX}${DETECT_SCRIPT}`, 12000);
  const detail = r.stderr.trim().split('\n').filter((l) => !l.startsWith('Warning: Permanently added')).pop() ?? null;
  if (r.timedOut) return { ok: false, connected: false, tmux: false, os: null, problem: 'timeout', hint: HINTS.timeout, detail };
  if (r.code !== 0) {
    const problem = classifySsh(r.stderr);
    return { ok: false, connected: false, tmux: false, os: null, problem, hint: HINTS[problem], detail };
  }
  const det = parseDetect(r.stdout);
  const tmux = det.capabilities.includes('tmux');
  return { ok: tmux, connected: true, tmux, os: det.os, problem: tmux ? null : 'no_tmux', hint: tmux ? null : HINTS.no_tmux, detail: null };
}
