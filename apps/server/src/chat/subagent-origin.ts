/**
 * Which subagent's turn made a live MCP call, keyed by the CLI's own tool_use_id (spec 2026-09-26
 * §4). The gate proposes an action before it can know which subagent's turn issued it — the MCP
 * call and the CLI's `task_started`/tool-use stream frames arrive on two separate paths, correlated
 * only by this id — so the stream side remembers the origin here the moment it learns it, and the
 * gate reads it back when the call itself arrives (either order is possible).
 *
 * In-memory only, and deliberately so: an origin only matters while the run that made the call is
 * still live, a restart drops every in-flight call anyway (the CLI reissues nothing tied to a
 * tool_use_id from a dead process), and it never needs to survive a redeploy. Bounded (`MAX_ENTRIES`)
 * so a very chatty session cannot grow this without limit, and time-boxed (`TTL_MS`) so a call that
 * never arrives does not pin an entry forever.
 */

export interface Origin {
  conversationId: string;
  subagentId: string;
}

const MAX_ENTRIES = 5000;
const TTL_MS = 60 * 60 * 1000;

const store = new Map<string, Origin & { at: number }>();

/** Records (or refreshes) the origin of a tool_use_id. Re-inserting moves it to the newest end of
 * the map, which is what makes "oldest key first" ordering correct for the eviction below. */
function remember(toolUseId: string, origin: Origin, now = Date.now()): void {
  store.delete(toolUseId);
  store.set(toolUseId, { ...origin, at: now });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** The origin of a tool_use_id, or undefined if it was never recorded or has aged past `TTL_MS`. */
function originOf(toolUseId: string, now = Date.now()): Origin | undefined {
  const entry = store.get(toolUseId);
  if (!entry) return undefined;
  if (now - entry.at > TTL_MS) {
    store.delete(toolUseId);
    return undefined;
  }
  return { conversationId: entry.conversationId, subagentId: entry.subagentId };
}

function clear(): void {
  store.clear();
}

export const subagentOrigins = { remember, originOf, clear };

/** The shape of a CLI tool_use id (`toolu_...`, but this only checks that it looks like an id):
 * letters, digits, underscore and hyphen, 1 to 128 characters. */
export const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Reads `_meta['claudecode/toolUseId']` off an MCP tools/call's `extra`, shape-checked before it is
 * trusted as an id: `_meta` arrives verbatim from the client, so anything other than a small
 * id-shaped string is dropped rather than stored or looked up. */
export function toolUseIdOf(meta: unknown): string | undefined {
  const v = (meta as Record<string, unknown> | undefined)?.['claudecode/toolUseId'];
  return typeof v === 'string' && TOOL_USE_ID.test(v) ? v : undefined;
}
