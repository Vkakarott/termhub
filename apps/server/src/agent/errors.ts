import type { RpcMethod, RpcParams, RpcResult } from '@termhub/agent-protocol';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { AgentClosedError, AgentRpcError, AgentTimeoutError } from './connection.js';
import { AgentOfflineError, agents } from './registry.js';

/**
 * Single place that turns an agent connection/RPC failure into the HTTP shape the routes
 * already use. Anything that isn't one of the known agent error classes is rethrown as-is.
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof AgentOfflineError || err instanceof AgentClosedError) {
    return new HttpError(503, 'Agente desconectado');
  }
  if (err instanceof AgentTimeoutError) {
    return new HttpError(504, 'A máquina não respondeu');
  }
  if (err instanceof AgentRpcError) {
    switch (err.rpcError.code) {
      case 'eperm':
        return new HttpError(403, 'Sem acesso à pasta na máquina (Acesso Total ao Disco?)');
      case 'notfound':
        return new HttpError(404, 'Não encontrado na máquina');
      case 'no_tmux':
        return new HttpError(502, 'tmux não encontrado na máquina');
      case 'invalid':
        return new HttpError(400, 'Parâmetros inválidos para a máquina');
      case 'failed':
        // The operation ran on the machine and reported why it failed (a message meant for the user).
        return new HttpError(502, err.rpcError.message);
      default:
        return new HttpError(502, 'Falha na máquina');
    }
  }
  throw err;
}

/** `a >= b` for dotted numeric versions ("0.1.4"); a missing component counts as 0. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Refuses, with a message that says what to do, when the connected agent predates an RPC —
 * an older agent drops a method it does not know, which would otherwise surface as a timeout.
 * An offline agent passes through: the RPC itself answers 503.
 */
export function requireAgentVersion(machine: Machine, min: string): void {
  const info = agents.info(machine.id);
  if (info && !versionAtLeast(info.agent_version, min)) {
    throw new HttpError(409, `Atualize o agente desta máquina (npm i -g @termhub/agent, versão ${min} ou mais nova)`, 'AGENT_OUTDATED');
  }
}

/** Calls a named RPC on the machine's agent connection, converting connection/protocol errors via toHttpError. */
export async function agentRpc<M extends RpcMethod>(machine: Machine, method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  try {
    return await agents.rpc(machine.id, method, params);
  } catch (err) {
    throw toHttpError(err);
  }
}
