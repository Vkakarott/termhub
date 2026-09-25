// Ported from apps/web/src/components/chat/ChatPanel.tsx's `mine` callback (~line 119, design spec
// §6): whether a live event belongs to the conversation this screen has open, so two open chats
// (the account-wide chat and a project's own) never mix their deltas or cards — the socket is per
// user, not per conversation, and carries every one of them at once.
//
// The web's rule is `e.conversation_id === undefined || e.conversation_id === conversationId`: an
// untagged event (an older server that predates project chats) is let through unknown, because
// there is no id it could ever be checked against. The mobile contract has no such server —
// `conversation_id` is a required field on every event but `hello` (`events.ts`; `hello` carries no
// conversation at all, it is the socket's own first frame) — so the rule collapses to "equal to the
// open conversation", and `conversationId === null` (nothing open yet, before the first `GET chat`
// resolves) drops everything, tagged or not, same as the web drops a tagged event before its own
// `conversationId` is known.
import type { ChatEvent } from './types';

/**
 * Curried so a store can hand `belongsTo(conversationId)` straight to `Array#filter`, and recompute
 * it only when `conversationId` itself changes.
 */
export function belongsTo(conversationId: string | null): (e: ChatEvent) => boolean {
  return (e) => conversationId !== null && 'conversation_id' in e && e.conversation_id === conversationId;
}
