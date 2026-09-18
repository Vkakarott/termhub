import { execFile } from 'node:child_process';
import os from 'node:os';
import type { RpcError } from '@termhub/agent-protocol';
import { REMOTE_PATH_PREFIX } from '@termhub/machine-ops';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * Set when `code` is `null` for a reason other than a timeout/signal: `'enoent'` when
   * `file` itself could not be spawned (binary missing), `'maxbuffer'` when stdout/stderr
   * exceeded the 8 MiB cap. Callers that used to treat every `code: null` as "binary missing"
   * must check this instead — a maxBuffer overflow is not the same failure as ENOENT.
   */
  error?: 'enoent' | 'maxbuffer';
}

export interface RunOptions {
  timeoutMs?: number;
  input?: Buffer;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Thrown by RPC handlers (see rpc/*.ts) to report a specific protocol error code instead of
 * letting an arbitrary Error fall through as a generic "internal" failure. `path` is echoed on
 * fs-flavoured errors so the server can point at the offending directory/file.
 */
export class RpcFailure extends Error {
  constructor(
    public code: RpcError['code'],
    message: string,
    public path?: string,
  ) {
    super(message);
  }
}

/**
 * Pulls the directory list out of REMOTE_PATH_PREFIX (e.g. `$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin`)
 * instead of retyping it, so the two PATH prefixes (SSH login shell vs. this local process) never drift apart.
 */
function pathPrefixDirs(): string {
  const m = REMOTE_PATH_PREFIX.match(/PATH="([^"]+):\$PATH"/);
  if (!m) throw new Error('unexpected REMOTE_PATH_PREFIX format');
  return m[1];
}

/** `process.env` with PATH prefixed by the same extra dirs SSH login sessions get (~/.local/bin, Homebrew, …). */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const prefix = pathPrefixDirs().replace('$HOME', os.homedir());
  return { ...base, PATH: `${prefix}:${base.PATH ?? ''}` };
}

/** `tmux` binary path: `$TMUX_PATH` override, or `tmux` resolved from PATH. */
export function tmuxPath(): string {
  return process.env.TMUX_PATH || 'tmux';
}

/**
 * Runs `file` with `args` (never a shell string built from user input — spawn takes an argv
 * array so nothing gets re-interpreted by a shell) and always resolves, never rejects: RPC
 * handlers turn a non-zero exit / timeout / spawn failure into an `RpcFailure` themselves.
 */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, input, env = agentEnv() } = opts;
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: !!e?.killed || e?.signal === 'SIGTERM',
          error: e?.code === 'ENOENT' ? 'enoent' : e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'maxbuffer' : undefined,
        });
      },
    );
    // Without this listener, a child that exits before reading stdin (e.g. a script whose
    // first line fails and hits `exit 1` before `cat`-ing stdin) raises an EPIPE on this
    // stream that — unhandled — throws and takes down the whole agent process. The execFile
    // callback above still reports the real exit code from `err`/`code`; this is a no-op.
    child.stdin?.on('error', () => {});
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/**
 * Runs `script` through `/bin/sh -c`. `script` must be a constant imported from
 * `@termhub/machine-ops` (e.g. `DETECT_SCRIPT`, `HARDWARE_SCRIPT`) or built by one of its
 * builders (`buildFsListScript`, `buildMkdirScript`, `buildPasteScript`, `credentialScript`) —
 * never a value that came from the server, which would let it inject shell syntax.
 */
export function sh(script: string, opts: RunOptions = {}): Promise<RunResult> {
  return run('/bin/sh', ['-c', script], opts);
}
