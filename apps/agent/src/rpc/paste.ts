import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { PASTE_MAX_BYTES, buildPasteScript } from '@termhub/machine-ops';
import { RpcFailure, sh } from '../exec.js';

/** Decodes the base64 payload and writes it to ~/.cache/termhub/paste/<name> on this machine. */
export async function pasteFile(params: RpcParams<'file.paste'>): Promise<RpcResult<'file.paste'>> {
  const data = Buffer.from(params.data_b64, 'base64');
  if (data.length > PASTE_MAX_BYTES) throw new RpcFailure('invalid', 'file too large');

  const r = await sh(buildPasteScript(params.name), { input: data, timeoutMs: 60_000 });
  if (r.timedOut) throw new RpcFailure('timeout', 'file.paste timed out');
  if (r.code !== 0) throw new RpcFailure('internal', `file.paste exited with code ${r.code}`);

  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const path = lines[lines.length - 1] ?? '';
  if (!path.startsWith('/')) throw new RpcFailure('internal', 'unexpected paste output');
  return { path };
}
