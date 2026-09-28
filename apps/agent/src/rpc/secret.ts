import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { RpcFailure, sh } from '../exec.js';

const SECRET_MAX = 4096;

/**
 * Reads a secret the machine already holds (today only `gh auth token`). Never logs stdout, and no
 * failure message carries the command's output: it may be the token itself.
 */
export async function read(params: RpcParams<'secret.read'>): Promise<RpcResult<'secret.read'>> {
  if (params.source !== 'gh_auth_token') throw new RpcFailure('invalid', 'unknown secret source');
  const r = await sh('gh auth token');
  if (r.timedOut) throw new RpcFailure('timeout', 'secret.read timed out');
  if (r.code !== 0) throw new RpcFailure('failed', 'gh auth token failed');
  const value = r.stdout.trim();
  if (!value) throw new RpcFailure('failed', 'gh auth token printed nothing');
  if (value.length > SECRET_MAX) throw new RpcFailure('failed', 'gh auth token printed an unexpected value');
  return { value };
}
