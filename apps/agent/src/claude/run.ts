import type { AgentMessage, ClaudeOpenParams } from '@termhub/agent-protocol';
import { buildClaudeArgs, mcpConfig } from '@termhub/claude-cli';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSocket } from '../client.js';
import type { ClaudeManager } from '../dispatch.js';
import { agentEnv } from '../exec.js';

/** Same deadline the container runs with (`apps/concierge/src/run.ts`): a run that overstays it is
 *  killed, so a CLI that hangs cannot keep running on someone's laptop for the rest of the day. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a killed run gets to exit on SIGTERM before it is taken out with SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** The CLI, resolved from the run's PATH like every other tool the agent runs — and what the log
 *  says is missing when this machine does not have it. */
const CLI = 'claude';

/** The protocol's closed set of end-of-run reasons (task-2 ruling R1), read off the message type so
 *  this file cannot drift from it: `'cli_missing' | 'run_failed' | 'killed'`. */
type ClosedReason = NonNullable<Extract<AgentMessage, { type: 'closed' }>['reason']>;

export interface ClaudeManagerDeps {
  log: (msg: string, meta?: object) => void;
  /** Base environment for the run; defaults to the agent's PATH-widened env (see `agentEnv`),
   *  which is how a service-managed agent finds a CLI installed under ~/.local/bin or Homebrew. */
  env?: NodeJS.ProcessEnv;
  /** Where the per-run private directory is created; defaults to the OS temp dir. */
  tmpDir?: string;
  timeoutMs?: number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Run {
  child: ChildProcess;
  /** The prompt already went in — and closed stdin with it, so later frames have nowhere to go. */
  promptSent: boolean;
  /** Kills the CLI and everything it started, escalating to SIGKILL after the grace period. */
  kill(): void;
  /** Sends `closed` (once) and removes the run's private directory. `notify: false` for a session
   *  that is already gone, where there is nobody left to ack to. */
  settle(code: number | null, reason?: ClosedReason, notify?: boolean): void;
}

/**
 * Runs headless Claude sessions for the server, one per channel: spawns the CLI, feeds it the
 * prompt on stdin, streams its stdout back a line per frame, and ends the channel with `closed`.
 *
 * Same shape as the PTY manager (`src/pty.ts`), so the dispatcher routes by kind and learns
 * nothing else: nothing here knows what a chat is, only how to run a CLI and stream it.
 */
export function createClaudeManager(deps: ClaudeManagerDeps): ClaudeManager {
  const runs = new Map<number, Run>();

  return {
    // Synchronous from end to end (the promise is for symmetry with the PTY manager), so no
    // `close` for this channel can interleave before the run is in `runs` and killable.
    async open(ch: number, params: ClaudeOpenParams, socket: AgentSocket): Promise<void> {
      if (runs.has(ch)) {
        socket.sendControl({ type: 'open_error', ch, error: { code: 'invalid', message: 'channel in use' } });
        return;
      }

      // The MCP config holds a live token of this user's, so it goes in a directory only they can
      // enter (mkdtemp is 0700) in a file only they can read, and it is removed on every way out of
      // this run: a normal exit, a kill, a dropped session, a spawn that never started.
      let dir: string | undefined;
      let mcpConfigPath: string;
      try {
        dir = mkdtempSync(join(deps.tmpDir ?? tmpdir(), 'termhub-claude-'));
        mcpConfigPath = join(dir, 'termhub-mcp.json');
        writeFileSync(mcpConfigPath, mcpConfig(params.mcp_url, params.token), { mode: 0o600 });
      } catch (err) {
        deps.log('claude run could not prepare its mcp config', { ch, error: message(err) });
        if (dir) rmSync(dir, { recursive: true, force: true });
        socket.sendControl({ type: 'open_error', ch, error: { code: 'internal', message: 'failed to prepare the claude run' } });
        return;
      }
      const runDir = dir;

      // The channel is acknowledged before the CLI is known to exist. A machine without `claude`
      // is the likeliest first failure of this feature and it has an end-of-run reason of its own
      // (`cli_missing`) that only `closed` can carry — answering `open_error` instead would settle
      // the open as a generic rejection and throw that reason away.
      socket.sendControl({ type: 'opened', ch });
      deps.log('claude run starting', { ch, resume: params.resume, model: params.model ?? null });

      const env = { ...(deps.env ?? agentEnv()) };
      // `null` means "the account this machine uses by default", which is not the account the agent
      // process itself happens to be pointed at: the inherited value must not stand in for it.
      if (params.config_dir === null) delete env.CLAUDE_CONFIG_DIR;
      else env.CLAUDE_CONFIG_DIR = params.config_dir;

      const args = buildClaudeArgs({
        session_id: params.session_id,
        resume: params.resume,
        mcp_config_path: mcpConfigPath,
        model: params.model ?? null,
      });

      let child: ChildProcess;
      try {
        // `detached` makes the CLI its own process group leader so a kill can take whatever it
        // started with it (an MCP server, a helper): a SIGTERM to the leader alone would leave
        // those running on the user's machine, which is the failure this design must not introduce.
        child = spawn(CLI, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        deps.log('claude run could not be started', { ch, cli: CLI, error: message(err) });
        rmSync(runDir, { recursive: true, force: true });
        socket.sendControl({ type: 'closed', ch, code: null, reason: 'run_failed' });
        return;
      }

      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let stderrBytes = 0;
      let buffer = '';

      function signalRun(signal: NodeJS.Signals): void {
        try {
          // A negative pid signals the whole process group `detached` put this child at the head of.
          if (child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The group is gone already (ESRCH), or the platform refused the group kill: fall back to
          // the child alone rather than leaving it alive.
          try {
            child.kill(signal);
          } catch {
            /* already dead */
          }
        }
      }

      function killRun(): void {
        if (child.exitCode !== null || child.signalCode !== null) return;
        signalRun('SIGTERM');
        if (escalation) return;
        // A CLI that ignores SIGTERM must not survive the channel that asked for it to stop.
        escalation = setTimeout(() => signalRun('SIGKILL'), KILL_GRACE_MS);
        escalation.unref();
      }

      function settle(code: number | null, reason?: ClosedReason, notify = true): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (runs.get(ch) === run) runs.delete(ch);
        try {
          rmSync(runDir, { recursive: true, force: true }); // the 0600 config holds a live token
        } catch (err) {
          // Settling runs from a child-process event: an unremovable directory must be a log line,
          // never an exception that reaches the event loop and takes the agent down.
          deps.log('claude run dir could not be removed', { ch, error: message(err) });
        }
        if (!notify) return;
        try {
          socket.sendControl(reason ? { type: 'closed', ch, code, reason } : { type: 'closed', ch, code });
        } catch (err) {
          deps.log('claude closed send failed', { ch, error: message(err) });
        }
      }

      function sendLine(line: string): void {
        // After the channel ended (a kill, a dropped session) the server has already let go of it:
        // whatever the CLI still writes on its way out must not be forwarded.
        if (settled) return;
        try {
          // The newline travels with the line: the server reassembles the stream by newline, as the
          // container's reader does, so a frame must never silently glue two lines together.
          socket.sendStream(ch, Buffer.from(`${line}\n`, 'utf8'));
        } catch (err) {
          deps.log('claude stream send failed', { ch, error: message(err) });
        }
      }

      const timer = setTimeout(() => {
        deps.log('claude run timed out', { ch, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        killRun();
      }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref();

      const run: Run = { child, promptSent: false, kill: killRun, settle };
      runs.set(ch, run);

      // A CLI that exits before reading the prompt (a rejected `--resume` fails at startup) turns
      // the stdin write into EPIPE; unhandled, that `error` event would take the whole agent down.
      child.stdin?.on('error', () => {});

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) sendLine(line);
      });

      // stderr is drained so a chatty CLI cannot block on a full pipe, and nothing but its size is
      // kept: it can carry the prompt back, and terminal content with it (spec §7.1), while the
      // closed set of end-of-run reasons gives it nowhere to travel to anyway.
      child.stderr?.on('data', (data: Buffer) => {
        stderrBytes += data.length;
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const missing = err.code === 'ENOENT';
        // Named, not generic: "this machine has no `claude`" is something the person can act on,
        // where "run failed" would send them hunting.
        deps.log(missing ? `claude cli not found on this machine (${CLI})` : 'claude run failed to start', { ch, cli: CLI, error: err.message });
        killRun();
        settle(null, missing ? 'cli_missing' : 'run_failed');
      });

      // `close`, not `exit`: by then every stdout chunk has been delivered, so nothing the CLI
      // wrote is lost to the channel ending a beat too early.
      child.on('close', (code: number | null) => {
        if (escalation) clearTimeout(escalation);
        if (buffer.trim()) sendLine(buffer);
        buffer = '';
        deps.log('claude run ended', { ch, code, stderrBytes });
        // A run we killed ourselves has already settled (`killed`, or `cli_missing` on a spawn that
        // never happened); this decides only the outcome of a run that ended on its own terms.
        if (code === 0) settle(0);
        else settle(code, 'run_failed');
      });
    },

    write(ch: number, data: Buffer): boolean {
      const run = runs.get(ch);
      if (!run) return false; // not one of ours: the caller routes the frame to the pty manager
      if (run.promptSent) {
        // The size, never the content: this is the prompt.
        deps.log('extra data on a claude channel ignored', { ch, bytes: data.length });
        return true;
      }
      run.promptSent = true;
      // The prompt goes in on stdin and nowhere else: argv is visible to every process on this
      // machine, and a prompt beginning with `-` would be read as a flag there. It arrives as one
      // frame and is the CLI's whole input, so stdin closes with it — `claude -p` waits for EOF.
      run.child.stdin?.end(data);
      return true;
    },

    close(ch: number): void {
      const run = runs.get(ch);
      if (!run) return;
      run.kill();
      // Always ack, like the pty manager: the server keeps the channel number reserved until it
      // sees `closed`, and the process exit may come later — or never, if the kill fails.
      run.settle(null, 'killed');
    },

    closeAll(): void {
      // The session is over (the socket is gone): nobody is left to ack to, but nothing may be
      // left running either.
      for (const run of [...runs.values()]) {
        run.kill();
        run.settle(null, 'killed', false);
      }
    },
  };
}
