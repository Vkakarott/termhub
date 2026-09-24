import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { agents } from '../agent/registry.js';
import type { Machine } from '../db/repositories/types.js';
import { sshBaseArgs } from '../terminal/machine-exec.js';
import { openAgentTunnel } from './agent-tunnel.js';
import type { WdaPorts } from './ports.js';
import { findFreePort, type Tunnel } from './tunnel-types.js';

export { findFreePort, type Tunnel } from './tunnel-types.js';

/** Só para testes: troca o binário do ssh e o timeout de prontidão. */
export interface OpenTunnelOptions {
  sshBin?: string;
  readyTimeoutMs?: number;
}

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 300;

/** Espera o ssh começar a aceitar conexões na porta local encaminhada (ou falhar ao iniciar/sair). */
function waitListening(port: number, proc: ChildProcess, stderr: () => string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      err ? reject(err) : resolve();
    };
    proc.once('close', (code) => finish(new Error(`ssh encerrou (código ${code}): ${stderr().trim()}`)));
    proc.once('error', (e) => finish(new Error(`ssh falhou ao iniciar: ${e.message}`)));
    const attempt = () => {
      if (done) return;
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        finish();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) finish(new Error(`túnel ssh não ficou pronto: ${stderr().trim()}`));
        else setTimeout(attempt, READY_POLL_MS);
      });
    };
    attempt();
  });
}

export async function openTunnel(machine: Machine, remote: WdaPorts, opts: OpenTunnelOptions = {}): Promise<Tunnel> {
  if (machine.type === 'local') {
    return { wdaPort: remote.wdaPort, mjpegPort: remote.mjpegPort, close() {}, onClose() {} };
  }
  if (machine.type === 'agent') return openAgentTunnel(machine.id, remote, agents);
  const sshBin = opts.sshBin ?? 'ssh';
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const [lp, lm] = await Promise.all([findFreePort(), findFreePort()]);
  const args = [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...sshBaseArgs(machine, 10),
    '-L',
    `127.0.0.1:${lp}:127.0.0.1:${remote.wdaPort}`,
    '-L',
    `127.0.0.1:${lm}:127.0.0.1:${remote.mjpegPort}`,
  ];
  const proc = spawn(sshBin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  let err = '';
  proc.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
  const closeCbs: ((e?: Error) => void)[] = [];
  let closed = false;
  const fail = (e: Error) => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb(e);
  };
  // Cobre tanto a queda do ssh depois do túnel pronto quanto a falha ao nem conseguir iniciar
  // (ENOENT, EMFILE, sem permissão): sem isso, 'error' no ChildProcess sem listener derruba o processo todo.
  proc.once('close', (code) => fail(new Error(`túnel ssh caiu (código ${code}): ${err.trim()}`)));
  proc.once('error', (e) => fail(new Error(`túnel ssh falhou ao iniciar: ${e.message}`)));
  try {
    await waitListening(lp, proc, () => err, readyTimeoutMs);
  } catch (e) {
    // Não deixa o ssh órfão rodando se a prontidão falhar/expirar.
    try {
      proc.kill('SIGTERM');
    } catch {
      /* já morreu */
    }
    const wrapped = e instanceof Error ? e : new Error(String(e));
    (wrapped as Error & { pid?: number }).pid = proc.pid;
    throw wrapped;
  }
  return {
    wdaPort: lp,
    mjpegPort: lm,
    close() {
      if (closed) return;
      closed = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* já morreu */
      }
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
  };
}
