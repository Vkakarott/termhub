// How one live event of the open conversation changes its thread (design spec §6): pure reducers
// over the slice the chat store keeps — the thread's messages and actions and the `live` buffer
// `foldLive` reads. The store decides which events reach here (`belongsTo`) and does the I/O.
import type { ChatAction, ChatEvent, ChatMessage } from './types';

/** The most live events kept at once — a long answer streams hundreds of deltas. */
export const LIVE_CAP = 500;

export interface EventSlice {
  messages: ChatMessage[];
  actions: ChatAction[];
  live: ChatEvent[];
}

/** The message a live event is about, if any. */
function liveMessageId(e: ChatEvent): string | null {
  if (e.type === 'message') return e.message.id;
  if (e.type === 'delta' || e.type === 'action' || e.type === 'reset' || e.type === 'action_result') return e.message_id;
  return null;
}

const capLive = (events: ChatEvent[]): ChatEvent[] => (events.length > LIVE_CAP ? events.slice(-LIVE_CAP) : events);

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === message.id);
  if (i < 0) return [...messages, message];
  return messages.map((m, j) => (j === i ? message : m));
}

/** Settles the pending action `id` as approved or denied. A card that has moved on already — a
 * re-read that says it ran, failed or expired — is never moved back; the same array when nothing
 * changes (idempotent). */
export function settlePending(actions: ChatAction[], id: string, status: 'approved' | 'denied'): ChatAction[] {
  if (!actions.some((a) => a.id === id && a.status === 'pending')) return actions;
  return actions.map((a) => (a.id === id ? { ...a, status } : a));
}

function actionFromConfirmation(e: Extract<ChatEvent, { type: 'confirmation' }>): ChatAction {
  return {
    id: e.action_id,
    tool: e.tool,
    args: e.args,
    class: e.class,
    status: 'pending',
    machine_id: e.machine_id,
    project_id: e.project_id,
    tab_id: e.tab_id,
    summary: e.summary,
    created_at: e.created_at,
  };
}

/**
 * The slice after `e`, and whether the thread must be re-read from the server (every `message`
 * event: the web's rule). Returns the same slice for an event that changes nothing.
 */
export function applyEvent(slice: EventSlice, e: ChatEvent): { slice: EventSlice; reread: boolean } {
  switch (e.type) {
    case 'message': {
      // The row is final (or just announced): its deltas give way to the row itself, shown at once
      // from the event and then confirmed by the re-read. An empty assistant row announces a run;
      // it stays in `live` so `foldLive` marks it started ("pensando…") until its first delta.
      const message = e.message;
      const announce = message.role === 'assistant' && !message.text && !message.error_code;
      const kept = slice.live.filter((ev) => liveMessageId(ev) !== message.id);
      return { slice: { ...slice, messages: upsertMessage(slice.messages, message), live: capLive(announce ? [...kept, e] : kept) }, reread: true };
    }
    case 'confirmation':
      if (slice.actions.some((a) => a.id === e.action_id)) return { slice, reread: false };
      return { slice: { ...slice, actions: [...slice.actions, actionFromConfirmation(e)] }, reread: false };
    case 'decision':
      return { slice: { ...slice, actions: settlePending(slice.actions, e.action_id, e.status) }, reread: false };
    case 'delta':
    case 'action':
    case 'reset':
      return { slice: { ...slice, live: capLive([...slice.live, e]) }, reread: false };
    default:
      return { slice, reread: false };
  }
}
