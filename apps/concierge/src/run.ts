import { buildClaudeArgs, classifyFailure, mcpConfig, type ClaudeFailureReason } from '@termhub/claude-cli';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunRequest {
  session_id: string;
  resume: boolean;
  text: string;
  config_dir: string;
  model?: string | null;
  /** short-lived termhub API token, read scope in step 1 */
  token: string;
  mcp_url: string;
}

/** Writes the MCP config the CLI loads into a private temp dir, never logged. */
function writeMcpConfig(dir: string, req: RunRequest): string {
  const path = join(dir, 'termhub-mcp.json');
  writeFileSync(path, mcpConfig(req.mcp_url, req.token), { mode: 0o600 });
  return path;
}

/**
 * Why a run failed, in a form the app is allowed to act on. Both the classification and its labels
 * now live in `@termhub/claude-cli`, beside the argv: the agent reads the same CLI's stderr on the
 * user's own machine and the two must never drift. Re-exported under the names this module has
 * always offered, so nothing downstream has to care where they moved.
 */
export type FailureReason = ClaudeFailureReason;
export { classifyFailure };

export class RunFailed extends Error {
  readonly reason: FailureReason;
  constructor(readonly code: number | null, readonly stderr: string) {
    super(`claude exited with ${code ?? 'signal'}`);
    this.reason = classifyFailure(stderr);
  }
}

/** Spawns the CLI and yields its stdout line by line. The prompt goes in on stdin, so it is never
 * argv and a prompt starting with "-" cannot be read as a flag. */
export async function* runClaude(req: RunRequest, opts: { cliPath?: string; tmpDir?: string; timeoutMs?: number } = {}): AsyncIterable<string> {
  const dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'run-'));
  const args = buildClaudeArgs({ ...req, mcp_config_path: writeMcpConfig(dir, req) });
  const child = spawn(opts.cliPath ?? 'claude', args, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: req.config_dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 10 * 60 * 1000);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  // A CLI that exits before reading the prompt — which is exactly what a rejected `--resume` does,
  // it fails at startup — makes this write fail with EPIPE. Unhandled, that `error` event takes the
  // whole container down, and the classified failure frame the app needs is never written.
  child.stdin.on('error', () => {});
  child.stdin.end(req.text);

  let buffer = '';
  try {
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) yield line;
    }
    if (buffer.trim()) yield buffer;
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    if (code !== 0) throw new RunFailed(code, stderr.slice(-2000));
  } finally {
    clearTimeout(timer);
    // The consumer may have stopped early (client disconnected): the timeout that would have
    // killed the child is gone, so kill it here or it keeps running with no safety net.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true }); // the 0600 MCP config holds a live token
  }
}
