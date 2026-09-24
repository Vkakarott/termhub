// Ported from apps/web/src/components/chat/ChatPanel.tsx's `live` useMemo (~lines 262-291, design
// spec §6): deltas and tool calls of the answer being written, keyed by message id, plus which
// assistant rows have shown any sign of life. Extracted out of the component and out of React: this
// folds a plain array of events instead of reading a `useMemo` dependency array, so a store can call
// it on whatever buffer of live events it keeps.
import type { ChatEvent } from './types';

export interface LiveFold {
  deltas: Map<string, string>;
  actions: Map<string, { tool: string }[]>;
  started: Set<string>;
}

/**
 * Deltas and the action trail of the answer being written, keyed by message id. A `reset` event —
 * the server retrying the run on a fresh CLI session — drops whatever streamed for that message so
 * far, so the abandoned half-answer never shows glued to the real one.
 *
 * `hello`, `confirmation`, `decision` and `action_result` events touch none of this and fall through
 * unhandled, same as on the web: there, `confirmation` and `decision` are handled by `ChatPanel`'s
 * own `onEvent` instead, never by this fold, and `action_result` was never read by it either; `hello`
 * has no web equivalent at all — it is the mobile socket's own first frame.
 */
export function foldLive(events: ChatEvent[]): LiveFold {
  const deltas = new Map<string, string>();
  const actions = new Map<string, { tool: string }[]>();
  /**
   * Assistant rows this fold has seen any sign of life from: the `message` event that announces a
   * run, but also its deltas and its tool calls — a store hydrated (or reconnected) after the run
   * began never sees the announcement, and a tool-only phase can run for tens of seconds with
   * nothing else to show. An empty bubble only deserves a "pensando…" while its run can still be
   * alive; a row left empty by a process death — which happens on every deploy — is never mentioned
   * here at all, so it reads as the failure it is instead of waiting for ever.
   */
  const started = new Set<string>();
  for (const e of events) {
    if (e.type === 'delta') {
      deltas.set(e.message_id, (deltas.get(e.message_id) ?? '') + e.delta);
      started.add(e.message_id);
    } else if (e.type === 'action') {
      actions.set(e.message_id, [...(actions.get(e.message_id) ?? []), { tool: e.tool }]);
      started.add(e.message_id);
    } else if (e.type === 'reset') {
      deltas.delete(e.message_id);
      actions.delete(e.message_id);
    } else if (e.type === 'message' && e.message.role === 'assistant' && !e.message.text && !e.message.error_code) {
      started.add(e.message.id);
    }
  }
  return { deltas, actions, started };
}
