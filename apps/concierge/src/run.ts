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

/** Tools the concierge must never have: with any of them it could reach a machine outside the MCP,
 * where the permission gate lives (spec §4.1). */
const DISALLOWED = 'Bash,Read,Write,Edit,WebFetch,WebSearch';

export function buildArgs(req: RunRequest & { mcp_config_path: string }): string[] {
  return [
    '-p',
    '--session-id', req.session_id,
    ...(req.resume ? ['--resume', req.session_id] : []),
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--mcp-config', req.mcp_config_path,
    '--strict-mcp-config',
    '--allowed-tools', 'mcp__termhub__*',
    '--disallowed-tools', DISALLOWED,
    ...(req.model ? ['--model', req.model] : []),
  ];
}

/** The MCP config the CLI loads: one HTTP server, the token in the header. Written per run into a
 * private temp dir, never logged. */
function writeMcpConfig(dir: string, req: RunRequest): string {
  const path = join(dir, 'termhub-mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { termhub: { type: 'http', url: req.mcp_url, headers: { Authorization: `Bearer ${req.token}` } } } }), { mode: 0o600 });
  return path;
}

export class RunFailed extends Error {
  constructor(readonly code: number | null, readonly stderr: string) {
    super(`claude exited with ${code ?? 'signal'}`);
  }
}

/** Spawns the CLI and yields its stdout line by line. The prompt goes in on stdin, so it is never
 * argv and a prompt starting with "-" cannot be read as a flag. */
export async function* runClaude(req: RunRequest, opts: { cliPath?: string; tmpDir?: string; timeoutMs?: number } = {}): AsyncIterable<string> {
  const dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'run-'));
  const args = buildArgs({ ...req, mcp_config_path: writeMcpConfig(dir, req) });
  const child = spawn(opts.cliPath ?? 'claude', args, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: req.config_dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 10 * 60 * 1000);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
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
