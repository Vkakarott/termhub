import type { ChatAction, ChatMessage } from './types';

export type ChatEntry = { kind: 'message'; at: string; message: ChatMessage } | { kind: 'action'; at: string; action: ChatAction };

/**
 * Merges messages and gate cards into one chronological thread, so a card renders next to the
 * answer that proposed it instead of in a separate list. Copies both inputs into entries first —
 * `messages` and `actions` are React state, re-fetched on every load and reconnect, and sorting
 * them in place would be a re-render bug that only shows up under StrictMode.
 */
export function chatTimeline(messages: ChatMessage[], actions: ChatAction[]): ChatEntry[] {
  // Actions first, deliberately: a stable sort with no tiebreak would just preserve this
  // concatenation order, so putting actions ahead of messages here means the "message before
  // action" rule below is doing the work, not an accident of array order. Removing that tiebreak
  // would now surface the wrong order (action before message on a tie) instead of hiding it.
  const entries: ChatEntry[] = [
    ...actions.map((action): ChatEntry => ({ kind: 'action', at: action.created_at, action })),
    ...messages.map((message): ChatEntry => ({ kind: 'message', at: message.created_at, message })),
  ];

  return entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    // A card is always proposed during the answer it belongs to, so on equal timestamps it reads
    // correctly after the message — spelled out here rather than left to rely on concatenation order.
    if (a.kind === b.kind) return 0;
    return a.kind === 'message' ? -1 : 1;
  });
}
