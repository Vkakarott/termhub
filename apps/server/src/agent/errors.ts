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
      default:
        return new HttpError(502, 'Falha na máquina');
    }
  }
  throw err;
}

/** Calls a named RPC on the machine's agent connection, converting connection/protocol errors via toHttpError. */
export async function agentRpc<M extends RpcMethod>(machine: Machine, method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  try {
    return await agents.rpc(machine.id, method, params);
  } catch (err) {
    throw toHttpError(err);
  }
}
