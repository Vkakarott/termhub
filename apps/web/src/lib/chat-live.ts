import { useCallback, useState } from 'react';
import type { ChatEvent } from './types';

/** One tool chip of a row being written — the shape `ChatTurn.tools` already takes. */
export type ChatTool = { tool: string };

/** What has streamed for one assistant row so far. */
export interface LiveRow {
  text: string;
  /** The same array reference until a new tool call lands: `ChatTurn`'s memo depends on that. */
  tools: readonly ChatTool[];
  /**
   * The row's run has shown a sign of life: its announcement (`message` with no text yet), a delta or a
   * tool call. A page opened after the run began never sees the announcement, and a tool-only phase can
   * run for tens of seconds with nothing else to show — and an empty row that nothing ever started is a
   * process death, which must read as the failure it is instead of waiting for ever.
   */
  started: boolean;
}

export interface LiveFold {
  /** Folds one event in. `true` when a row changed (and `version` moved). */
  apply(ev: ChatEvent): boolean;
  get(messageId: string): LiveRow | undefined;
  /** Marks the rows the server lists as still to be answered (`open_answer_ids`), except closed ones.
   *  Add-only: a row is never unmarked because the list lacks it. */
  seed(ids: readonly string[]): boolean;
  /** Forgets everything: the panel shows another conversation now. */
  clear(): void;
  /** Closes rows a re-read dropped from the thread (the server deleted them), without marking them
   *  removed. `true` when a row held here went. */
  closeRows(ids: readonly string[]): boolean;
  /** The row had its final `message`, its `run_finished` or was removed: nothing opens it again. */
  isClosed(messageId: string): boolean;
  /** The ids of the rows the server deleted. A new set each time one is added. */
  removed(): ReadonlySet<string>;
  /** Counts changes; a React consumer stores it in state to re-render. */
  version: number;
}

const NO_TOOLS: readonly ChatTool[] = Object.freeze([]);
const EMPTY_ROW: LiveRow = { text: '', tools: NO_TOOLS, started: false };

/**
 * Folds WebSocket events incrementally, per message id: each frame costs O(1) instead of a rebuild over
 * the whole buffer. A row is replaced by a new object when it changes (so a reader can compare by
 * identity) and left as is otherwise. Besides the rows it keeps a closed set (spec 2026-09-29 §5): an
 * answer that ended or was removed never opens again, whatever a late event or an older snapshot says.
 */
export function createLiveFold(): LiveFold {
  const rows = new Map<string, LiveRow>();
  const closed = new Set<string>();
  let removed: ReadonlySet<string> = new Set<string>();

  const start = (id: string): boolean => {
    if (closed.has(id)) return false;
    const row = rows.get(id);
    if (row?.started) return false;
    rows.set(id, row ? { ...row, started: true } : { text: '', tools: NO_TOOLS, started: true });
    return true;
  };
  const close = (id: string): boolean => {
    closed.add(id);
    return rows.delete(id);
  };

  const fold: LiveFold = {
    version: 0,
    get: (id) => rows.get(id),
    isClosed: (id) => closed.has(id),
    removed: () => removed,
    seed(ids) {
      let changed = false;
      for (const id of ids) changed = start(id) || changed;
      if (changed) fold.version += 1;
      return changed;
    },
    closeRows(ids) {
      let changed = false;
      for (const id of ids) changed = close(id) || changed;
      if (changed) fold.version += 1;
      return changed;
    },
    clear() {
      rows.clear();
      closed.clear();
      removed = new Set<string>();
      fold.version += 1;
    },
    apply(ev) {
      let changed = false;
      switch (ev.type) {
        case 'delta': {
          if (closed.has(ev.message_id)) break;
          const row = rows.get(ev.message_id) ?? EMPTY_ROW;
          rows.set(ev.message_id, { text: row.text + ev.delta, tools: row.tools, started: true });
          changed = true;
          break;
        }
        case 'action': {
          if (closed.has(ev.message_id)) break;
          const row = rows.get(ev.message_id) ?? EMPTY_ROW;
          rows.set(ev.message_id, { text: row.text, tools: [...row.tools, { tool: ev.tool }], started: true });
          changed = true;
          break;
        }
        case 'reset': {
          // The server retried the run on a fresh session: the half-answer goes, the run is alive.
          const row = rows.get(ev.message_id);
          if (row && (row.text !== '' || row.tools.length > 0)) {
            rows.set(ev.message_id, { text: '', tools: NO_TOOLS, started: row.started });
            changed = true;
          }
          break;
        }
        case 'run_started':
          changed = start(ev.message_id);
          break;
        case 'run_finished':
          if (ev.message_id !== null) changed = close(ev.message_id);
          break;
        case 'message_removed':
          changed = close(ev.message_id);
          removed = new Set(removed).add(ev.message_id);
          changed = true;
          break;
        case 'message': {
          const m = ev.message;
          if (m.role !== 'assistant') {
            changed = rows.delete(m.id);
          } else if (!m.text && !m.error_code) {
            // The announcement of a run: an assistant row with nothing in it yet.
            changed = start(m.id);
          } else {
            // The stored row (text, or the error it ended in): the panel merges it into `messages` in
            // the same event, so what streamed for it is let go of here.
            changed = close(m.id);
          }
          break;
        }
        default:
          break;
      }
      if (changed) fold.version += 1;
      return changed;
    },
  };
  return fold;
}

/**
 * The fold as React state: one fold per mounted panel, a `version` that moves on every change (so the
 * panel re-renders and reads the rows it needs through `fold.get`), and a `push`, a `seed`, a `clear`
 * and a `closeRows` that never change identity, so the handlers that call them can be memoised.
 */
export function useChatLive(): { fold: LiveFold; version: number; push(ev: ChatEvent): void; seed(ids: readonly string[]): void; clear(): void; closeRows(ids: readonly string[]): void } {
  const [fold] = useState(createLiveFold);
  const [version, setVersion] = useState(0);
  const push = useCallback(
    (ev: ChatEvent) => {
      if (fold.apply(ev)) setVersion(fold.version);
    },
    [fold],
  );
  const seed = useCallback(
    (ids: readonly string[]) => {
      if (fold.seed(ids)) setVersion(fold.version);
    },
    [fold],
  );
  const clear = useCallback(() => {
    fold.clear();
    setVersion(fold.version);
  }, [fold]);
  const closeRows = useCallback(
    (ids: readonly string[]) => {
      if (fold.closeRows(ids)) setVersion(fold.version);
    },
    [fold],
  );
  return { fold, version, push, seed, clear, closeRows };
}
