// Copied verbatim from apps/web/src/lib/chat-timeline.ts (design spec §6, "Chat logic" row); only
// the import of the shared types was adapted — `./types` here re-exports the contract's own types
// under the web's names (see `types.ts`), instead of the web's own `lib/types.ts`. Delete this copy
// once `@termhub/mobile-api` exports it (design spec §6).
import type { ChatAction, ChatMessage } from './types';

export type ChatEntry = { kind: 'message'; at: string; message: ChatMessage } | { kind: 'action'; at: string; action: ChatAction };

/**
 * Merges messages and gate cards into one chronological thread, so a card renders next to the
 * answer that proposed it instead of in a separate list. Copies both inputs into entries first —
 * `messages` and `actions` are React state, re-fetched on every load and reconnect, and sorting
 * them in place would be a re-render bug that only shows up under StrictMode.
 */
export function chatTimeline(messages: ChatMessage[], actions: ChatAction[]): ChatEntry[] {
  /**
   * `GET /api/chat` reads two independent windows: the newest 200 messages and the newest 200
   * actions. Only gated writes ever land in the action trail, so past 200 messages the message
   * window starts mid-history while the much shorter action window still reaches back to the
   * beginning of the conversation — every older card would then sort above the oldest visible
   * message and `/chat` would open with a block of already-decided cards and no messages around
   * them. A card belongs next to the answer that proposed it, so a card whose answer is not in the
   * message window is not shown at all. With no messages to compare against there is no cutoff to
   * apply: keep every action rather than inventing one.
   */
  const oldestMessageAt = messages.reduce<string | null>((oldest, m) => (oldest === null || m.created_at < oldest ? m.created_at : oldest), null);
  const visibleActions = oldestMessageAt === null ? actions : actions.filter((action) => action.created_at >= oldestMessageAt);

  // Actions first, deliberately: a stable sort with no tiebreak would just preserve this
  // concatenation order, so putting actions ahead of messages here means the "message before
  // action" rule below is doing the work, not an accident of array order. Removing that tiebreak
  // would now surface the wrong order (action before message on a tie) instead of hiding it.
  const entries: ChatEntry[] = [
    ...visibleActions.map((action): ChatEntry => ({ kind: 'action', at: action.created_at, action })),
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
