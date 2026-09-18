import type { PtyOpenParams, RpcMethod, ServerMessage } from '@termhub/agent-protocol';
import { RPC } from '@termhub/agent-protocol';
import type { AgentSocket } from './client.js';
import { RpcFailure } from './exec.js';
import type { Handlers } from './rpc/index.js';

/**
 * PTY side of the dispatcher — implemented by Task 12 (`src/pty.ts`) and injected here so
 * dispatch logic can be unit-tested without a real pseudo-terminal. `open` errors are reported
 * to the server by the manager itself (an `open_error` control message), not by the dispatcher.
 */
export interface PtyManager {
  open(ch: number, params: PtyOpenParams, socket: AgentSocket): Promise<void>;
  write(ch: number, data: Buffer): void;
  resize(ch: number, cols: number, rows: number): void;
  close(ch: number): void;
  closeAll(): void;
}

export interface DispatcherDeps {
  handlers: Handlers;
  pty: PtyManager;
  log: (msg: string, meta?: object) => void;
}

type RpcServerMessage = Extract<ServerMessage, { type: 'rpc' }>;

async function handleRpc(msg: RpcServerMessage, socket: AgentSocket, handlers: Handlers, log: DispatcherDeps['log']): Promise<void> {
  const method = msg.method as RpcMethod;
  const def = RPC[method];
  const handler = handlers[method];
  // Unreachable in practice: `method` was already validated against the RPC catalog by
  // serverMessage.safeParse() in client.ts before this ever runs. Kept as a defensive fallback.
  if (!def || !handler) {
    socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: 'invalid', message: 'unknown method' } });
    return;
  }

  const parsedParams = def.params.safeParse(msg.params);
  if (!parsedParams.success) {
    socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: 'invalid', message: 'invalid params' } });
    return;
  }

  let result: unknown;
  try {
    // The runtime call is keyed by the same `method` that picked both `def` and `handler`, so
    // params and handler always agree — TS just can't see that through the mapped type.
    result = await (handler as (params: unknown) => Promise<unknown>)(parsedParams.data);
  } catch (err) {
    if (err instanceof RpcFailure) {
      socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: err.code, message: err.message, path: err.path } });
    } else {
      // Never log params (may contain a machine path or a credential's config dir) — method
      // name only, plus the stack for debugging.
      log('rpc handler failed', { method, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: 'internal', message: 'internal error' } });
    }
    return;
  }

  const parsedResult = def.result.safeParse(result);
  if (!parsedResult.success) {
    log('rpc handler returned an invalid result', { method, issues: parsedResult.error.issues.length });
    socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: 'internal', message: 'internal error' } });
    return;
  }

  socket.sendControl({ type: 'rpc_result', id: msg.id, ok: true, result: parsedResult.data });
}

/** Routes a validated server control message to its named RPC handler or the PTY manager. */
export function createDispatcher(deps: DispatcherDeps): (msg: ServerMessage, socket: AgentSocket) => void {
  return (msg, socket) => {
    switch (msg.type) {
      case 'rpc':
        void handleRpc(msg, socket, deps.handlers, deps.log);
        break;
      case 'open':
        // Errors are reported to the server by the PTY manager itself (open_error); this catch
        // only guards against an unexpected rejection leaking as an unhandled promise.
        deps.pty.open(msg.ch, msg.params, socket).catch((err) => {
          deps.log('pty.open rejected unexpectedly', { ch: msg.ch, error: err instanceof Error ? err.message : String(err) });
        });
        break;
      case 'resize':
        deps.pty.resize(msg.ch, msg.cols, msg.rows);
        break;
      case 'close':
        deps.pty.close(msg.ch);
        break;
    }
  };
}
