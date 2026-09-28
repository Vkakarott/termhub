// How one live event of the open conversation changes its thread (design spec §6): pure reducers
// over the slice the chat store keeps — the thread's messages and actions and the `live` fold of the
// answer being written. The store decides which events reach here (`belongsTo`) and does the I/O.
import type { TChatAttachment } from '@/services/api/contract';
import { applyLive, type LiveFold } from './live';
import { upsertSubagent } from './subagents';
import { upsertTabSuggestion } from './tab-suggestion-text';
import type { ChatAction, ChatEvent, ChatGrant, ChatMessage, ChatProjectGrant, ChatStandingGrant, SubagentView, TabQuestion, TabSuggestion } from './types';

export interface EventSlice {
  messages: ChatMessage[];
  actions: ChatAction[];
  /** The answer being written: streamed text, tool calls and started rows, by message id. */
  live: LiveFold;
  /** The conversation's trusted tabs; at most one per tab (a new grant replaces the old one). */
  grants: ChatGrant[];
  /** The conversation's trusted projects' boards ("Permitir sempre neste projeto"); at most one per
   * project (a new grant replaces the old one). */
  projectGrants: ChatProjectGrant[];
  /** The tabs' questions pushed into this conversation (spec 2026-09-25 §6.3). */
  tabQuestions: TabQuestion[];
  /** The tabs' suggestions pushed into this conversation (spec 2026-09-25 tab suggestions §6.4). */
  tabSuggestions: TabSuggestion[];
  /** The subagents panel of this conversation, newest first (spec 2026-09-26 panel §4). */
  subagents: SubagentView[];
  /** Ids whose "Cancelar" came back with `subagent_cancel_failed`, or any other cancel failure the
   * store marks the same way (spec 2026-09-26 panel §5.4); cleared once a fresh `subagent` event
   * for that id arrives. */
  cancelFailed: string[];
}

const NO_ATTACHMENTS: readonly TChatAttachment[] = [];

/** The web's `sameAttachments`: what a stored attachment can change after the phone first saw it (an extraction ended, or gave up). */
function sameAttachments(a: readonly TChatAttachment[] = NO_ATTACHMENTS, b: readonly TChatAttachment[] = NO_ATTACHMENTS): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i]!.id && x.status === b[i]!.status && x.error_code === b[i]!.error_code);
}

/**
 * The web's `lib/chat-merge.ts` (`mergeMessage`): `msg` into `list` by id — appended when new,
 * replaced when something changed, and the very same `list` (same row objects) when nothing did, so
 * a memoised row keeps its props. `usage` is the server's JSON: compared by value. Attachments count
 * too: a re-read is how a status event the phone missed (backgrounded, offline) gets corrected.
 */
export function mergeMessage(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = list.findIndex((m) => m.id === msg.id);
  if (i < 0) return [...list, msg];
  const old = list[i]!;
  const same =
    old.text === msg.text && old.error_code === msg.error_code && old.created_at === msg.created_at && JSON.stringify(old.usage ?? null) === JSON.stringify(msg.usage ?? null) && sameAttachments(old.attachments, msg.attachments);
  return same ? list : list.map((m, j) => (j === i ? msg : m));
}

/**
 * A re-read's snapshot into the thread it refreshes (same conversation): every server row merges by
 * id (`mergeMessage`: the server's version wins, untouched rows keep their objects); a row the
 * snapshot lacks stays when it is this device's own (`local`) or newer than the snapshot's newest
 * row — a `message` event that landed while the GET was in flight — and goes otherwise (the server
 * no longer has it). The very same `current` back when nothing changed.
 */
export function mergeThread(current: ChatMessage[], server: ChatMessage[]): ChatMessage[] {
  const ids = new Set(server.map((m) => m.id));
  const newest = server.reduce((max, m) => (m.created_at > max ? m.created_at : max), '');
  const kept = current.filter((m) => ids.has(m.id) || m.local !== undefined || m.created_at > newest);
  return server.reduce(mergeMessage, kept.length === current.length ? current : kept);
}

/**
 * The messages with `attachment` replaced by id inside whichever message carries it (the web's
 * `patchMessageAttachment`); the same array, and the same message objects, when nothing changed.
 */
export function patchMessageAttachment(messages: ChatMessage[], attachment: TChatAttachment): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    const list = m.attachments;
    if (!list) return m;
    const i = list.findIndex((a) => a.id === attachment.id);
    if (i < 0) return m;
    const current = list[i]!;
    if (current.status === attachment.status && current.error_code === attachment.error_code && JSON.stringify(current.meta) === JSON.stringify(attachment.meta)) return m;
    changed = true;
    return { ...m, attachments: list.map((a, j) => (j === i ? attachment : a)) };
  });
  return changed ? next : messages;
}

/** Settles the pending action `id` as approved or denied. A card that has moved on already — a
 * re-read that says it ran, failed or expired — is never moved back; the same array when nothing
 * changes (idempotent). */
export function settlePending(actions: ChatAction[], id: string, status: 'approved' | 'denied'): ChatAction[] {
  if (!actions.some((a) => a.id === id && a.status === 'pending')) return actions;
  return actions.map((a) => (a.id === id ? { ...a, status } : a));
}

/** Every tab-question event carries the whole card: replace it by id, or append it. */
export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[] {
  return list.some((x) => x.id === q.id) ? list.map((x) => (x.id === q.id ? q : x)) : [...list, q];
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
    grant_id: null,
    summary: e.summary,
    // Which subagent's turn proposed it (spec 2026-09-26 §4), when there is one — carried through
    // verbatim, including its absence (`undefined`) on an older server.
    subagent: e.subagent,
    created_at: e.created_at,
  };
}

/**
 * The slice after `e` — the same object for an event that changes nothing. A `message` merges by id
 * and asks for no re-read (spec §4.2 "Merge on message"): the event is the row; only a reconnect
 * re-reads the thread, in the store.
 */
export function applyEvent(slice: EventSlice, e: ChatEvent): EventSlice {
  switch (e.type) {
    case 'message': {
      const messages = mergeMessage(slice.messages, e.message);
      const live = applyLive(slice.live, e);
      return messages === slice.messages && live === slice.live ? slice : { ...slice, messages, live };
    }
    case 'confirmation': {
      const existing = slice.actions.find((a) => a.id === e.action_id);
      if (!existing) return { ...slice, actions: [...slice.actions, actionFromConfirmation(e)] };
      // The live run learned which subagent proposed a card already on screen, after the card was
      // already published with none (spec 2026-09-26 §4): merged in, the card's status untouched. A
      // repeat with nothing new changes nothing.
      if (!e.subagent) return slice;
      return { ...slice, actions: slice.actions.map((a) => (a.id === e.action_id ? { ...a, subagent: e.subagent } : a)) };
    }
    case 'decision': {
      const actions = settlePending(slice.actions, e.action_id, e.status);
      return actions === slice.actions ? slice : { ...slice, actions };
    }
    case 'grant':
      // One active grant per (tab, tool), as on the server: a narrow grant never drops a terminal one.
      return { ...slice, grants: [...slice.grants.filter((g) => g.id !== e.grant.id && !(g.tab_id === e.grant.tab_id && g.tool === e.grant.tool)), e.grant] };
    case 'grant_revoked':
      return { ...slice, grants: slice.grants.filter((g) => g.id !== e.grant_id) };
    case 'project_grant':
      return { ...slice, projectGrants: [...slice.projectGrants.filter((g) => g.id !== e.grant.id && g.project_id !== e.grant.project_id), e.grant] };
    case 'project_grant_revoked':
      return { ...slice, projectGrants: slice.projectGrants.filter((g) => g.id !== e.grant_id) };
    case 'granted_action':
      // A send_input run under a grant never asked: its card arrives whole, already executed.
      return { ...slice, actions: slice.actions.some((a) => a.id === e.action.id) ? slice.actions.map((a) => (a.id === e.action.id ? e.action : a)) : [...slice.actions, e.action] };
    case 'tab_question':
    case 'tab_question_answered':
    case 'tab_question_closed':
      return { ...slice, tabQuestions: upsertTabQuestion(slice.tabQuestions, e.question) };
    case 'tab_suggestion':
    case 'tab_suggestion_closed':
      return { ...slice, tabSuggestions: upsertTabSuggestion(slice.tabSuggestions, e.suggestion) };
    case 'attachment_status': {
      const messages = patchMessageAttachment(slice.messages, e.attachment);
      return messages === slice.messages ? slice : { ...slice, messages };
    }
    case 'subagent': {
      const subagents = upsertSubagent(slice.subagents, e.subagent);
      // Whatever this row is now, a stale "Cancelar" failure from before no longer applies.
      const cancelFailed = slice.cancelFailed.includes(e.subagent.id) ? slice.cancelFailed.filter((id) => id !== e.subagent.id) : slice.cancelFailed;
      return subagents === slice.subagents && cancelFailed === slice.cancelFailed ? slice : { ...slice, subagents, cancelFailed };
    }
    case 'subagent_cancel_failed':
      return slice.cancelFailed.includes(e.subagent_id) ? slice : { ...slice, cancelFailed: [...slice.cancelFailed, e.subagent_id] };
    case 'delta':
    case 'action':
    case 'reset': {
      const live = applyLive(slice.live, e);
      return live === slice.live ? slice : { ...slice, live };
    }
    default:
      return slice;
  }
}

/**
 * A standing grant ("Liberar sem prazo", spec 2026-09-28 TER-386) is not bound to a conversation: its
 * two events apply to every slot that shows it, whatever conversation they are tagged with — the same
 * set `GET chat` returns (the slot's project, or all of them in the account-wide chat, `slotProject`
 * null); a revoke is applied by id. A re-grant of the same kind on the same project replaces the older
 * one, as on the server. The same array for an event that changes nothing here.
 */
export function applyStandingGrantEvent(grants: ChatStandingGrant[], slotProject: string | null, e: ChatEvent): ChatStandingGrant[] {
  if (e.type === 'standing_grant_revoked') return grants.some((g) => g.id === e.grant_id) ? grants.filter((g) => g.id !== e.grant_id) : grants;
  if (e.type !== 'standing_grant' || (slotProject !== null && e.grant.project_id !== slotProject)) return grants;
  return [...grants.filter((g) => g.id !== e.grant.id && !(g.project_id === e.grant.project_id && g.kind === e.grant.kind)), e.grant];
}
