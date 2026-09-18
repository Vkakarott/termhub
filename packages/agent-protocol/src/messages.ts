import { z } from 'zod';
import { rpcErrorSchema, rpcMethod, sessionName, machinePath } from './rpc.js';

export const PROTOCOL_VERSION = 1;
export const CLOSE = { UNAUTHORIZED: 4401, CONFLICT: 4409, VIOLATION: 1008 } as const;

const channel = z.number().int().min(1).max(0xffffffff);
const rpcId = z.string().min(1).max(64);

export const helloMessage = z.object({
  type: z.literal('hello'),
  protocol: z.number().int().min(1),
  agent_version: z.string().max(32),
  os: z.enum(['macos', 'linux']),
  arch: z.string().max(16),
  hostname: z.string().max(255),
  tmux: z.boolean(),
  tools: z.array(z.string().max(32)).max(64),
});

// zod's discriminatedUnion rejects two members with the same 'type' literal, so the
// rpc_result ok/error variants are folded into a single member (see task-1 ruling R1).
export const agentMessage = z.discriminatedUnion('type', [
  helloMessage,
  z.object({ type: z.literal('rpc_result'), id: rpcId, ok: z.boolean(), result: z.unknown().optional(), error: rpcErrorSchema.optional() }),
  z.object({ type: z.literal('opened'), ch: channel }),
  z.object({ type: z.literal('open_error'), ch: channel, error: rpcErrorSchema }),
  z.object({ type: z.literal('closed'), ch: channel, code: z.number().int().nullable() }),
]);

export const ptyOpenParams = z.object({ session: sessionName, cwd: machinePath, cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) });

export const serverMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rpc'), id: rpcId, method: rpcMethod, params: z.unknown() }),
  z.object({ type: z.literal('open'), ch: channel, kind: z.literal('pty'), params: ptyOpenParams }),
  z.object({ type: z.literal('resize'), ch: channel, cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }),
  z.object({ type: z.literal('close'), ch: channel }),
]);

export type HelloMessage = z.infer<typeof helloMessage>;
export type AgentMessage = z.infer<typeof agentMessage>;
export type ServerMessage = z.infer<typeof serverMessage>;
export type PtyOpenParams = z.infer<typeof ptyOpenParams>;
