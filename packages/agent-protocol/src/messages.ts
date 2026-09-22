import { z } from 'zod';
import { rpcErrorSchema, rpcMethod, sessionName, machinePath } from './rpc.js';

export const PROTOCOL_VERSION = 1;
export const CLOSE = { UNAUTHORIZED: 4401, CONFLICT: 4409, VIOLATION: 1008 } as const;

const channel = z.number().int().min(1).max(0xffffffff);
const rpcId = z.string().min(1).max(64);

// The closed set of reasons a channel ended for something other than a clean process exit
// (see task-2 ruling R1). Defined once so the agent and the server report the same outcome
// under the same name: "claude is not installed on the host" — this feature's most likely
// first failure per the spec — must read as one helpful sentence everywhere, not a specific
// message on one side and a generic one on the other because each side spelled it differently.
//
// `missing_session` is the one the server acts on rather than renders: the CLI cannot find the
// conversation it was asked to resume (a local history pruned or rotated on the user's own
// machine), and the chat service retries once on a fresh session. Without it in this set that
// self-healing is lost on the user-hosted path and every later message in the conversation
// fails for ever as a generic `run_failed`.
export const closedReason = z.enum(['cli_missing', 'run_failed', 'killed', 'missing_session']);

/**
 * What an agent advertises in `hello.capabilities` beyond the baseline `pty` channel, written once for
 * both sides of the wire: the agent puts it in its `hello` (`apps/agent/src/run.ts`), the server
 * requires it before it opens a channel of that kind (`chat/host.ts`, `chat/agent-runner.ts`). Two
 * spellings of this string would mean a server that silently refuses every agent, or worse an "update
 * your agent" sentence shown to someone whose agent is perfectly current.
 */
export const CAPABILITY_CLAUDE = 'claude';

export const helloMessage = z.object({
  type: z.literal('hello'),
  protocol: z.number().int().min(1),
  agent_version: z.string().max(32),
  os: z.enum(['macos', 'linux']),
  arch: z.string().max(16),
  hostname: z.string().max(255),
  tmux: z.boolean(),
  tools: z.array(z.string().max(32)).max(64),
  /** `status`/`doctor` reachability check: the server validates the token and protocol as
   *  usual but does not attach — it answers by closing 1000 `probe-ok`, so a probe never
   *  replaces the machine's live session. */
  probe: z.boolean().optional(),
  // What this agent understands beyond the baseline `pty` channel (e.g. `claude`, for a
  // headless Claude run). Optional, defaulting to [] — every agent already in the field sent
  // `hello` before this field existed, so it must keep parsing, reading as "no capabilities"
  // rather than failing validation or coming back `undefined`. The server decides whether it
  // may open a `claude` channel from this list, before it ever tries.
  capabilities: z.array(z.string().max(64)).max(32).default([]),
});

// zod's discriminatedUnion rejects two members with the same 'type' literal, so the
// rpc_result ok/error variants are folded into a single member (see task-1 ruling R1).
export const agentMessage = z.discriminatedUnion('type', [
  helloMessage,
  z.object({ type: z.literal('rpc_result'), id: rpcId, ok: z.boolean(), result: z.unknown().optional(), error: rpcErrorSchema.optional() }),
  z.object({ type: z.literal('opened'), ch: channel }),
  z.object({ type: z.literal('open_error'), ch: channel, error: rpcErrorSchema }),
  // `reason` is absent for a clean exit and for every pty close today; a headless claude run
  // (task 3) sets it so the server can render the same failure the same way every time.
  z.object({ type: z.literal('closed'), ch: channel, code: z.number().int().nullable(), reason: closedReason.optional() }),
]);

export const ptyOpenParams = z.object({ session: sessionName, cwd: machinePath, cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) });

export const claudeOpenParams = z.object({
  session_id: z.string(),
  resume: z.boolean(),
  // null selects the machine's default Claude account; a path names a specific one.
  config_dir: z.string().nullable(),
  mcp_url: z.string(),
  // The user's own token for this run, minted by the server per run and revoked the moment
  // the next one starts. It travels here, in the frame that opens the channel, rather than
  // over the channel itself, because the channel doesn't exist yet when the agent needs it —
  // opening a channel to the user's own machine is exactly the trust boundary this grant
  // belongs at, so there is no separate, later place to hand it over.
  token: z.string(),
  model: z.string().nullable().optional(),
});

const openPty = z.object({ type: z.literal('open'), ch: channel, kind: z.literal('pty'), params: ptyOpenParams });
const openClaude = z.object({ type: z.literal('open'), ch: channel, kind: z.literal('claude'), params: claudeOpenParams });

// zod's discriminatedUnion on 'type' can't hold two 'open' members with different 'kind'
// literals (see the rpc_result note above), so `open` is two full members tried in a plain
// union alongside the rest, instead of a single folded member. Linear try-each rather than a
// hash lookup, but `kind` and `params` stay correctly paired: `kind: 'pty'` with claude-shaped
// params (or the reverse) matches neither member and is rejected, not silently accepted.
export const serverMessage = z.union([
  z.object({ type: z.literal('rpc'), id: rpcId, method: rpcMethod, params: z.unknown() }),
  openPty,
  openClaude,
  z.object({ type: z.literal('resize'), ch: channel, cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }),
  z.object({ type: z.literal('close'), ch: channel }),
]);

export type HelloMessage = z.infer<typeof helloMessage>;
export type AgentMessage = z.infer<typeof agentMessage>;
export type ServerMessage = z.infer<typeof serverMessage>;
export type PtyOpenParams = z.infer<typeof ptyOpenParams>;
export type ClaudeOpenParams = z.infer<typeof claudeOpenParams>;
