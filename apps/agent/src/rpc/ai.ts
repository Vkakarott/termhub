import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { DEFAULT_CONFIG_DIRS, configDirPrefix, credentialScript } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/** Reads the CLI credential for `provider` off disk (or the macOS keychain). Never logs stdout. */
export async function credential(params: RpcParams<'ai.credential'>): Promise<RpcResult<'ai.credential'>> {
  let prefix: string;
  try {
    prefix = configDirPrefix(params.config_dir, DEFAULT_CONFIG_DIRS[params.provider]);
  } catch (err) {
    throw new RpcFailure('invalid', err instanceof Error ? err.message : 'invalid config dir');
  }
  const script = `${prefix}; ${credentialScript(params.provider)}`;
  const r = await sh(script);
  if (r.timedOut) throw new RpcFailure('timeout', 'ai.credential timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `ai.credential exited with code ${r.code}`);
  return { stdout: r.stdout };
}
