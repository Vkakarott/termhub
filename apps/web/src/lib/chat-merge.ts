import type { ChatAttachment, ChatMessage } from './types';

const NONE: readonly ChatAttachment[] = [];

/** What a stored attachment can change after the panel first saw it (an extraction ended, or gave up). */
function sameAttachments(a: readonly ChatAttachment[] = NONE, b: readonly ChatAttachment[] = NONE): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i].id && x.status === b[i].status && x.error_code === b[i].error_code);
}

/** The fields a stored row can change after the panel first saw it. */
function same(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.text === b.text &&
    a.error_code === b.error_code &&
    a.role === b.role &&
    a.created_at === b.created_at &&
    sameAttachments(a.attachments, b.attachments) &&
    JSON.stringify(a.notice ?? null) === JSON.stringify(b.notice ?? null)
  );
}

const isAnswered = (m: ChatMessage): boolean => m.role === 'assistant' && (Boolean(m.text) || Boolean(m.error_code));
const isEmptyAnswer = (m: ChatMessage): boolean => m.role === 'assistant' && !m.text && !m.error_code;

/**
 * Applies one `message` event to the list of messages: replaces the row with that id, or appends the
 * row when it is new, but never a final answer by an empty one. Returns `list` itself when the stored row says nothing new — every other row keeps
 * its object either way, so a memoised row only re-renders when its own message changed.
 */
export function mergeMessage(list: readonly ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const at = list.findIndex((m) => m.id === msg.id);
  if (at === -1) return [...list, msg];
  // An answer never goes from final back to empty: the empty version is older, whatever brought it.
  if (isAnswered(list[at]) && isEmptyAnswer(msg)) return list as ChatMessage[];
  if (same(list[at], msg)) return list as ChatMessage[];
  const next = list.slice();
  next[at] = msg;
  return next;
}

/**
 * The rows of the thread on screen that a re-read of the same conversation drops: the snapshot lacks
 * them and their `message` event did not reach the screen while the read was in flight. The server
 * deleted them (an answer that never started, a `message_removed` missed while the socket was down,
 * a server that predates that event), so nothing will ever answer them: the caller closes them.
 */
export function droppedRows(current: readonly ChatMessage[], server: readonly ChatMessage[], arrived: ReadonlySet<string>): string[] {
  const ids = new Set(server.map((m) => m.id));
  return current.filter((m) => !ids.has(m.id) && !arrived.has(m.id)).map((m) => m.id);
}

/**
 * A re-read of the same conversation into the thread on screen (spec 2026-09-29 §5): a row the screen
 * holds as final keeps its version over the snapshot's empty one; a row the screen saw removed is left
 * out; a row the snapshot lacks goes, unless its `message` event reached the screen while the read was
 * in flight (`arrived`) — it is newer than the snapshot, not deleted; every other row is the
 * snapshot's. The very same `current` back when nothing changed.
 *
 * Not a comparison of `created_at` with the snapshot's newest row: an answer is always newer than its
 * question, so a deleted answer would pass it and stay on screen for good.
 */
export function mergeThread(current: readonly ChatMessage[], server: readonly ChatMessage[], removed: ReadonlySet<string>, arrived: ReadonlySet<string>): ChatMessage[] {
  const listed = server.filter((m) => !removed.has(m.id));
  const ids = new Set(listed.map((m) => m.id));
  const byId = new Map(current.map((m) => [m.id, m]));
  const merged = listed.map((m) => {
    const old = byId.get(m.id);
    if (!old) return m;
    if (isAnswered(old) && isEmptyAnswer(m)) return old;
    return same(old, m) ? old : m;
  });
  const newer = current.filter((m) => !ids.has(m.id) && !removed.has(m.id) && arrived.has(m.id));
  const next = [...merged, ...newer];
  return next.length === current.length && next.every((m, i) => m === current[i]) ? (current as ChatMessage[]) : next;
}
