// The answer being written, keyed by message id (design spec §6; chat redesign spec §4.2
// "Incremental fold"): the web's `lib/chat-live.ts` in the immutable form zustand state needs.
// `applyLive` costs O(1) per event and hands back the very same fold when the event changes nothing,
// replacing only the map it touched otherwise — so a selector on one row's text changes only when
// that row's text does. `foldLive` is the batch form over a list of events.
import type { ChatEvent, ChatMessage } from './types';

export interface LiveFold {
  deltas: Map<string, string>;
  actions: Map<string, { tool: string }[]>;
  /**
   * Assistant rows this fold has seen any sign of life from: the `message` event that announces a
   * run, but also its deltas and its tool calls — a store hydrated (or reconnected) after the run
   * began never sees the announcement, and a tool-only phase can run for tens of seconds with
   * nothing else to show. An empty bubble only deserves a "pensando…" while its run can still be
   * alive; a row left empty by a process death — which happens on every deploy — is never mentioned
   * here at all, so it reads as the failure it is instead of waiting for ever.
   */
  started: Set<string>;
  /** Rows that had their final `message`, their `run_finished` or were removed: nothing opens them
   * again. A snapshot older than the event would otherwise bring the row back as being answered. */
  closed: Set<string>;
  /** Rows the server deleted: a snapshot that still lists one leaves it out. */
  removed: Set<string>;
}

export const emptyFold = (): LiveFold => ({ deltas: new Map(), actions: new Map(), started: new Set(), closed: new Set(), removed: new Set() });

const withAdded = (set: Set<string>, id: string): Set<string> => (set.has(id) ? set : new Set(set).add(id));

function without<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** Drops what streamed for `id`. A `reset` (the server retrying the run on a fresh CLI session) keeps
 * the row started — the run is still alive; a final `message` drops that too. */
function drop(fold: LiveFold, id: string, keepStarted: boolean): LiveFold {
  const hasDeltas = fold.deltas.has(id);
  const hasActions = fold.actions.has(id);
  const hasStarted = !keepStarted && fold.started.has(id);
  if (!hasDeltas && !hasActions && !hasStarted) return fold;
  const started = hasStarted ? new Set(fold.started) : fold.started;
  if (hasStarted) started.delete(id);
  return { ...fold, deltas: hasDeltas ? without(fold.deltas, id) : fold.deltas, actions: hasActions ? without(fold.actions, id) : fold.actions, started };
}

/** The row is open: started, unless it was closed. The very same fold when nothing changes. */
function open(fold: LiveFold, id: string): LiveFold {
  if (fold.closed.has(id) || fold.started.has(id)) return fold;
  return { ...fold, started: withAdded(fold.started, id) };
}

/** The row is over: what streamed for it goes, and nothing opens it again. */
function close(fold: LiveFold, id: string, removed: boolean): LiveFold {
  const dropped = drop(fold, id, false);
  const closed = withAdded(dropped.closed, id);
  const gone = removed ? withAdded(dropped.removed, id) : dropped.removed;
  if (dropped === fold && closed === fold.closed && gone === fold.removed) return fold;
  return { ...dropped, closed, removed: gone };
}

/** The rows the server lists as still to be answered (`open_answer_ids`). Add-only: a started mark
 * is never cleared because the list lacks it, and a closed row is never opened again. */
export function seedLive(fold: LiveFold, ids: readonly string[]): LiveFold {
  return ids.reduce(open, fold);
}

/** Closes the rows a re-read dropped from the thread (the server deleted them), without marking
 * them removed. The very same fold when every one of them was closed already. */
export function closeLive(fold: LiveFold, ids: readonly string[]): LiveFold {
  return ids.reduce((f, id) => close(f, id, false), fold);
}

/**
 * The fold after one event (spec 2026-09-29 §5). `hello`, `confirmation`, `decision`,
 * `action_result`, the grant, tab question and suggestion events and a `run_finished` with no
 * message id (a run that could not start) touch none of this and fall through unchanged: the store
 * handles those. A `message` for an assistant row that is final (text or an error code), a
 * `run_finished` with its id and a `message_removed` close the row — the row itself now carries the
 * text, or is gone; an empty one, and `run_started`, open it unless it was closed. A user message
 * changes nothing here. Nothing streams into a closed row.
 */
export function applyLive(fold: LiveFold, e: ChatEvent): LiveFold {
  switch (e.type) {
    case 'delta':
      if (fold.closed.has(e.message_id)) return fold;
      return {
        ...fold,
        deltas: new Map(fold.deltas).set(e.message_id, (fold.deltas.get(e.message_id) ?? '') + e.delta),
        started: withAdded(fold.started, e.message_id),
      };
    case 'action':
      if (fold.closed.has(e.message_id)) return fold;
      return {
        ...fold,
        actions: new Map(fold.actions).set(e.message_id, [...(fold.actions.get(e.message_id) ?? []), { tool: e.tool }]),
        started: withAdded(fold.started, e.message_id),
      };
    case 'reset':
      return drop(fold, e.message_id, true);
    case 'run_started':
      return open(fold, e.message_id);
    case 'run_finished':
      return e.message_id === null ? fold : close(fold, e.message_id, false);
    case 'message_removed':
      return close(fold, e.message_id, true);
    case 'message': {
      const { message } = e;
      if (message.role !== 'assistant') return fold;
      if (!message.text && !message.error_code) return open(fold, message.id);
      return close(fold, message.id, false);
    }
    default:
      return fold;
  }
}

/**
 * The fold after a re-read of the thread (a reconnect, most often): a row the thread shows finished
 * — text or an error — carries its answer now, so what streamed for it goes and the row is closed,
 * as its final `message` event would have done; a row still empty keeps its streamed prefix on screen, and an id the thread
 * does not have is left alone (its events may still be on their way). The very same fold back when
 * nothing was finished.
 */
export function pruneLive(fold: LiveFold, messages: readonly ChatMessage[]): LiveFold {
  return messages.reduce((f, m) => (m.role === 'assistant' && (m.text || m.error_code) ? close(f, m.id, false) : f), fold);
}

/** The fold of a whole list of events, from nothing — the batch form, for tests and re-folds. */
export function foldLive(events: ChatEvent[]): LiveFold {
  return events.reduce(applyLive, emptyFold());
}
