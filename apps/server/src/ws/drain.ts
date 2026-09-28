import type { FastifyBaseLogger } from 'fastify';
import { WebSocket, type WebSocketServer } from 'ws';

/** Close code for "this server is restarting / the machine is reconnecting": clients reconnect at once (spec 2026-09-27). */
export const RESTART_CLOSE = 1012;
const DRAIN_BUDGET_MS = 15_000;
const SOCKET_BUDGET_MS = 3_000;
/** `suspend` gets its own share of the drain budget, so the agents and sockets are handed over even if it hangs. */
const SUSPEND_BUDGET_MS = 8_000;
/** After `terminate()` the socket is destroyed; its `close` follows within a tick or two. Bounded anyway. */
const TERMINATE_GRACE_MS = 1_000;

export interface Lifecycle {
  readonly draining: boolean;
  startDraining(): void;
}

export function createLifecycle(): Lifecycle {
  let draining = false;
  return {
    get draining() {
      return draining;
    },
    startDraining() {
      draining = true;
    },
  };
}

/** Resolves when `work` settles or after `ms`, whichever comes first; true when `work` won. */
export async function within(work: Promise<unknown>, ms: number, onTimeout?: () => void): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => {
      onTimeout?.();
      r(false);
    }, ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Closes every client of these servers with `code`, then terminates whatever has not finished the handshake in `budgetMs`. */
export async function closeSockets(servers: Iterable<WebSocketServer>, opts: { code?: number; reason?: string; budgetMs?: number } = {}): Promise<void> {
  const clients = [...servers].flatMap((s) => [...s.clients]);
  if (clients.length === 0) return;
  const done = Promise.all(
    clients.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.once('close', () => resolve());
          ws.close(opts.code ?? RESTART_CLOSE, opts.reason ?? 'service restart');
        }),
    ),
  );
  if (await within(done, opts.budgetMs ?? SOCKET_BUDGET_MS)) return;
  for (const ws of clients) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  await within(done, TERMINATE_GRACE_MS);
}

/**
 * The handover on SIGTERM (spec 2026-09-27 §5.2): stop taking new sockets, release the live chat runs, send the agents to
 * the other colour, then every other client. Each step logs and carries on if it fails; the whole thing is bounded.
 */
export async function drain(deps: {
  lifecycle: Lifecycle;
  suspend: () => Promise<void>;
  closeAgents: () => number;
  servers: WebSocketServer[];
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  budgetMs?: number;
  suspendBudgetMs?: number;
}): Promise<void> {
  const started = Date.now();
  deps.lifecycle.startDraining();
  const steps = (async () => {
    const suspended = deps.suspend().catch((err: unknown) => deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'drain: suspend failed'));
    await within(suspended, deps.suspendBudgetMs ?? SUSPEND_BUDGET_MS, () => deps.log.warn({}, 'drain: suspend budget exceeded'));
    let agentsClosed = 0;
    try {
      agentsClosed = deps.closeAgents();
    } catch (err) {
      deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'drain: closing agents failed');
    }
    await closeSockets(deps.servers);
    deps.log.info({ agents: agentsClosed, ms: Date.now() - started }, 'drain: sockets handed over');
  })();
  await within(steps, deps.budgetMs ?? DRAIN_BUDGET_MS, () => deps.log.warn({}, 'drain: budget exceeded'));
}

/** `/api/ready`: the database answers and this process is not draining. */
export async function readinessCheck(
  query: () => Promise<unknown>,
  lifecycle: Lifecycle,
  timeoutMs = 2_000,
): Promise<{ status: number; body: { ok: boolean; reason?: 'database' | 'draining' } }> {
  if (lifecycle.draining) return { status: 503, body: { ok: false, reason: 'draining' } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([query(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)))]);
    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 503, body: { ok: false, reason: 'database' } };
  } finally {
    clearTimeout(timer);
  }
}
