import { z } from 'zod';

export const SESSION_RE = /^[A-Za-z0-9_-]+$/;
export const sessionName = z.string().min(1).max(128).regex(SESSION_RE);
/** Absolute, or "~" / "~/…" (expanded on the machine). No NUL or newline. */
export const machinePath = z.string().min(1).max(4096).refine((p) => (p === '~' || p.startsWith('~/') || p.startsWith('/')) && !/[\0\n\r]/.test(p), 'invalid path');
/** Sanitized file name: what paste-file.safeName() produces. */
export const pasteName = z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/);
export const aiProvider = z.enum(['claude', 'chatgpt', 'gemini', 'antigravity']);

/** The only keys a terminal tool may press (spec §4.2): no arbitrary key names reach tmux. */
export const TMUX_KEYS = ['Enter', 'Escape', 'C-c', 'Up', 'Down', 'Tab', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export const tmuxKey = z.enum(TMUX_KEYS);
export type TmuxKey = (typeof TMUX_KEYS)[number];

export const TEXT_MAX_CHARS = 4000;

export const rpcErrorSchema = z.object({
  /** `failed`: the operation ran on the machine and `message` says why it failed, in words meant for the user. */
  code: z.enum(['eperm', 'notfound', 'no_tmux', 'timeout', 'invalid', 'internal', 'failed']),
  message: z.string().max(2000),
  path: z.string().max(4096).optional(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

const DEFAULT_TIMEOUT = 8_000;
const def = <P extends z.ZodTypeAny, R extends z.ZodTypeAny>(params: P, result: R, timeoutMs = DEFAULT_TIMEOUT) => ({ params, result, timeoutMs });

export const RPC = {
  'tmux.list': def(z.object({}), z.object({ sessions: z.array(sessionName) })),
  'tmux.kill': def(z.object({ session: sessionName }), z.object({ killed: z.boolean() })),
  'tmux.capture': def(z.object({ session: sessionName, lines: z.number().int().min(1).max(5000) }), z.object({ text: z.string() })),
  /** Idempotent: creates the detached session in `cwd` when it is missing. `created` says whether it had to. */
  'tmux.ensure': def(z.object({ session: sessionName, cwd: machinePath }), z.object({ created: z.boolean() }), 10_000),
  /**
   * Types `text` literally, then (with `enter`) presses Enter on its own after a short pause.
   * `paste`: deliver `text` as a tmux buffer paste instead of typed keystrokes, so a TUI reads
   * an embedded newline as part of the pasted text rather than as Enter (since agent 0.3.0).
   */
  'tmux.sendText': def(z.object({ session: sessionName, text: z.string().max(TEXT_MAX_CHARS), enter: z.boolean(), paste: z.boolean().optional() }), z.object({ sent: z.literal(true) }), 10_000),
  'tmux.sendKey': def(z.object({ session: sessionName, key: tmuxKey }), z.object({ sent: z.literal(true) }), 10_000),
  'tools.detect': def(z.object({}), z.object({ os: z.string().nullable(), tools: z.array(z.string().max(32)) })),
  'hw.probe': def(z.object({}), z.object({ stdout: z.string() }), 15_000),
  'fs.list': def(z.object({ path: machinePath }), z.object({ stdout: z.string() })),
  'fs.mkdir': def(
    z.object({
      parent: machinePath,
      name: z.string().min(1).max(255).regex(/^[^/\\\0\n\r]+$/),
      /** `mkdir -p`: create missing parents too (ensureDirectory parity with the ssh/local branch). Default: leaf only. */
      recursive: z.boolean().optional(),
    }),
    z.object({ stdout: z.string() }),
  ),
  'ai.credential': def(z.object({ provider: aiProvider, config_dir: machinePath.nullable() }), z.object({ stdout: z.string() }), 10_000),
  'file.paste': def(z.object({ name: pasteName, data_b64: z.string().min(1).max(28 * 1024 * 1024) }), z.object({ path: z.string() }), 60_000),
  /** Monitor hooks (see @termhub/machine-ops hooks.ts): the agent writes the script, env and config entries under its own $HOME. */
  /** `claude_dirs`: Claude config dirs besides ~/.claude (accounts with CLAUDE_CONFIG_DIR), hooked when they exist; since agent 0.1.5. */
  /** `cursor` in the result: ~/.cursor/hooks.json (Cursor CLI), written when ~/.cursor exists; since agent 0.3.1 (older agents leave it out). */
  'hooks.install': def(
    z.object({
      hooks_url: z.string().min(1).max(2048).regex(/^https?:\/\/[^\s'"]+$/),
      token: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
      claude_dirs: z.array(machinePath).max(16).optional(),
    }),
    z.object({
      home: z.string(),
      claude: z.enum(['installed', 'skipped']),
      codex: z.enum(['installed', 'skipped']),
      cursor: z.enum(['installed', 'skipped']).optional(),
      claude_dirs: z.array(z.string()).optional(),
    }),
    15_000,
  ),
  'hooks.uninstall': def(z.object({ claude_dirs: z.array(machinePath).max(16).optional() }), z.object({ removed: z.boolean() }), 15_000),
  /** Installs `version` of @termhub/agent with npm; when the agent runs as a service it then exits so the service relaunches the new code (since agent 0.2.1). */
  'agent.update': def(
    z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }),
    z.object({ installed_version: z.string(), restart: z.enum(['service', 'manual']) }),
    180_000,
  ),
} as const;

export type RpcMethod = keyof typeof RPC;
export const RPC_METHODS = Object.keys(RPC) as RpcMethod[];
export const rpcMethod = z.enum(RPC_METHODS as [RpcMethod, ...RpcMethod[]]);
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RPC)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RPC)[M]['result']>;
