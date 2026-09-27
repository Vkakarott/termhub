import { z } from 'zod';
import { chatAttachment } from './attachments.js';

/** Mirrors `ChatMessage` in `apps/server/src/db/repositories/chat.ts`. */
export const chatMessage = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  usage: z.unknown().nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  /** The files sent with a user message (spec 2026-09-26 §5.5); absent when there are none, and on older servers. */
  attachments: z.array(chatAttachment).optional(),
});

/** Mirrors `ChatActionClass` in `apps/server/src/db/repositories/chat-actions.ts`. */
export const chatActionClass = z.enum(['read', 'write', 'irreversible']);

export const chatActionStatus = z.enum(['pending', 'approved', 'denied', 'expired', 'executed', 'failed']);

/** Mirrors the server's `ChatActionCard` (chat-actions-view.ts): a write the concierge proposed, with
 * the server-composed pt-BR `summary`. `grant_id` names the tab grant it ran under (optional: older
 * servers do not send it). `subagent` names which subagent's turn proposed it (spec 2026-09-26 §4) —
 * optional and nullable: null when the top-level run proposed it, absent from an older server. */
export const chatActionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  class: chatActionClass,
  status: chatActionStatus,
  machine_id: z.string().nullable(),
  project_id: z.string().nullable(),
  tab_id: z.string().nullable(),
  grant_id: z.string().nullable().optional(),
  summary: z.string(),
  subagent: z.object({ id: z.string(), description: z.string() }).nullable().optional(),
  created_at: z.string(),
});

/** "Permitir sempre nesta aba" while it holds (server `ChatGrantView`). */
export const chatGrantSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  tool: z.string(),
  source_action_id: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  tab_name: z.string().nullable(),
});

/** "Permitir sempre neste projeto" while it holds (server `ChatProjectGrantView`): the project's board
 * in this conversation. `project_name` is null when the project is gone. */
export const chatProjectGrantSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  project_name: z.string().nullable(),
  source_action_id: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});

/** How a listed grant stands (server `ChatGrantState`). */
export const chatGrantState = z.enum(['active', 'expired', 'revoked', 'ended']);

/** One row of "Abas confiáveis" (server `ChatGrantListItem`): a tab grant, or (with `kinds=all`) a
 * project grant, which carries no tab. */
export const chatGrantListItemSchema = chatGrantSchema.extend({
  /** Absent from servers before project grants: those only list tab grants. */
  kind: z.enum(['tab', 'project']).default('tab'),
  tab_id: z.string().nullable(),
  tool: z.string().nullable(),
  tab_name: z.string().nullable(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  conversation_id: z.string(),
  conversation_project_name: z.string().nullable(),
  conversation_archived: z.boolean(),
  state: chatGrantState,
  ended_at: z.string().nullable(),
});

export const chatGrantListResponse = z.object({ grants: z.array(chatGrantListItemSchema), next_cursor: z.string().nullable() });

/** `GET chat/grants`, web and phone alike. */
export const chatGrantListQuery = z.object({
  state: z.enum(['active', 'ended']),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** `all` adds project grants; without it an old app never sees a row with no tab. */
  kinds: z.enum(['tab', 'all']).default('tab'),
});

/** Mirrors `TabQuestionView` (apps/server/src/db/repositories/tab-questions-view.ts): a question a tab
 * put to the person, with what the chat answered. `recommended` comes out of Claude Code's own label. */
export const tabQuestionOption = z.object({ label: z.string(), description: z.string(), recommended: z.boolean() });
export const tabQuestionItem = z.object({ question: z.string(), header: z.string(), multi_select: z.boolean(), options: z.array(tabQuestionOption) });
export const tabQuestionStatus = z.enum(['open', 'answered', 'answered_in_tab', 'expired', 'failed']);

/** Mirrors `TabQuestionSuggestion` (apps/server/src/chat/decision-text.ts): a pre-selected answer from
 * a similar past decision, offered before the person picks (spec 2026-09-26 §4) — suggest only, never
 * sent on its own. */
export const tabQuestionSuggestionSchema = z.object({
  items: z.array(
    z.object({
      question_index: z.number().int(),
      // Required for installed builds; `""` on a concierge suggestion that cited no decision (spec 2026-09-26 concierge memory §3.2).
      decision_id: z.string(),
      similarity: z.number(),
      selected: z.array(z.number().int()),
      text: z.string().optional(),
      source: z.object({ question: z.string(), project_name: z.string().nullable(), answered_at: z.string() }),
    }),
  ),
});

/** Mirrors `AutoAnswer` (apps/server/src/db/repositories/tab-questions.ts): a countdown that sends the
 * proposed answer by itself when due, unless the person cancels it (spec 2026-09-26 concierge memory §6).
 * `sources` cite what backed it (a past decision, or a memory item). */
export const tabQuestionAutoAnswerSchema = z.object({
  answer: z.object({ answers: z.array(z.object({ selected: z.array(z.number().int()), text: z.string().optional() })) }),
  // Plain strings, like `sources.kind`: a value a newer server adds must not break an installed app.
  // Known today: `by` 'memory' | 'concierge'; `status` 'scheduled' | 'cancelled' | 'sent' | 'failed'.
  by: z.string(),
  reason: z.string(),
  sources: z.array(z.object({ kind: z.string(), id: z.string() })),
  due_at: z.string(),
  status: z.string(),
  error_code: z.string().optional(),
  decided_by: z.string().optional(),
  claimed_at: z.string().optional(),
});

const tabQuestionCommon = {
  id: z.string(),
  tab_id: z.string(),
  tab_name: z.string().nullable(),
  status: tabQuestionStatus,
  error_code: z.string().nullable(),
  created_at: z.string(),
  answered_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  /** Only while the card is `open`; absent from an older server. */
  suggestion: tabQuestionSuggestionSchema.nullable().optional(),
  /** The countdown, while open (or once sent/failed); absent from an older server, stripped by an older app. */
  auto_answer: tabQuestionAutoAnswerSchema.nullable().optional(),
  /** `'auto'` when the countdown sent the answer; absent from an older server. */
  answered_via: z.enum(['card', 'auto']).nullable().optional(),
};
export const tabQuestionSchema = z.discriminatedUnion('kind', [
  z.object({
    ...tabQuestionCommon,
    kind: z.literal('choice'),
    payload: z.object({ questions: z.array(tabQuestionItem) }),
    answer: z.object({ answers: z.array(z.object({ selected: z.array(z.number().int()), text: z.string().optional() })) }).nullable(),
  }),
  z.object({
    ...tabQuestionCommon,
    kind: z.literal('permission'),
    payload: z.object({ tool_name: z.string() }),
    answer: z.object({ allow: z.boolean(), text: z.string().optional() }).nullable(),
  }),
]);
/** A suggestion's life: `dismissed` is its own ("Dispensar"); a question never has it. */
export const tabSuggestionStatus = z.enum(['open', 'answered', 'answered_in_tab', 'expired', 'failed', 'dismissed']);
/** Mirrors a suggestion row's `TabQuestionView` (spec 2026-09-25 tab suggestions §6.2): Claude Code's
 * dimmed next prompt in a tab; `answer.text` is what the person sent. Kept apart from `tabQuestionSchema`
 * so an app that predates it keeps parsing `tab_question*` events and `tab_questions`. */
export const tabSuggestionSchema = z.object({
  id: z.string(),
  tab_id: z.string(),
  tab_name: z.string().nullable(),
  kind: z.literal('suggestion'),
  // `context`: the agent's message the suggestion answers (spec 2026-09-26 §6.3). Optional: a server before
  // TER-96 sends none; an app before it strips it (a plain z.object).
  payload: z.object({ text: z.string(), context: z.string().nullable().optional() }),
  status: tabSuggestionStatus,
  answer: z.object({ text: z.string() }).nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  answered_at: z.string().nullable(),
  closed_at: z.string().nullable(),
});

/** A concierge subagent's lifecycle (spec 2026-09-26 panel §4). */
export const subagentStatusSchema = z.enum(['running', 'stopping', 'completed', 'failed', 'stopped', 'interrupted']);

/** One row of the subagents panel: its description and type, never its prompt nor its work. */
export const subagentViewSchema = z.object({
  id: z.string(),
  description: z.string(),
  subagent_type: z.string().nullable(),
  status: subagentStatusSchema,
  started_at: z.string(),
  ended_at: z.string().nullable(),
});
export type TSubagentView = z.infer<typeof subagentViewSchema>;

// Mirrors the `ChatEvent` union in `apps/server/src/chat/bus.ts`, plus the `hello` variant the
// mobile socket sends first (there is no browser-side equivalent: the app has no other way to
// learn the protocol version and the server's clock before its first real event).
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int(), server_time: z.string() }),
  z.object({ type: z.literal('message'), user_id: z.string(), conversation_id: z.string(), message: chatMessage }),
  z.object({ type: z.literal('delta'), user_id: z.string(), conversation_id: z.string(), message_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal('action'), user_id: z.string(), conversation_id: z.string(), message_id: z.string(), tool: z.string(), tool_use_id: z.string(), args: z.unknown() }),
  z.object({ type: z.literal('action_result'), user_id: z.string(), conversation_id: z.string(), message_id: z.string(), tool_use_id: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal('reset'), user_id: z.string(), conversation_id: z.string(), message_id: z.string() }),
  z.object({
    type: z.literal('confirmation'),
    user_id: z.string(),
    conversation_id: z.string(),
    action_id: z.string(),
    tool: z.string(),
    args: z.unknown(),
    class: chatActionClass,
    machine_id: z.string().nullable(),
    project_id: z.string().nullable(),
    tab_id: z.string().nullable(),
    summary: z.string(),
    subagent: z.object({ id: z.string(), description: z.string() }).nullable().optional(),
    created_at: z.string(),
  }),
  z.object({ type: z.literal('decision'), user_id: z.string(), conversation_id: z.string(), action_id: z.string(), status: z.enum(['approved', 'denied']) }),
  z.object({ type: z.literal('grant'), user_id: z.string(), conversation_id: z.string(), grant: chatGrantSchema }),
  z.object({ type: z.literal('grant_revoked'), user_id: z.string(), conversation_id: z.string(), grant_id: z.string() }),
  z.object({ type: z.literal('project_grant'), user_id: z.string(), conversation_id: z.string(), grant: chatProjectGrantSchema }),
  z.object({ type: z.literal('project_grant_revoked'), user_id: z.string(), conversation_id: z.string(), grant_id: z.string() }),
  z.object({ type: z.literal('granted_action'), user_id: z.string(), conversation_id: z.string(), action: chatActionSchema }),
  z.object({ type: z.literal('tab_question'), user_id: z.string(), conversation_id: z.string(), question: tabQuestionSchema }),
  z.object({ type: z.literal('tab_question_answered'), user_id: z.string(), conversation_id: z.string(), question: tabQuestionSchema }),
  z.object({ type: z.literal('tab_question_closed'), user_id: z.string(), conversation_id: z.string(), question: tabQuestionSchema }),
  z.object({ type: z.literal('tab_suggestion'), user_id: z.string(), conversation_id: z.string(), suggestion: tabSuggestionSchema }),
  z.object({ type: z.literal('tab_suggestion_closed'), user_id: z.string(), conversation_id: z.string(), suggestion: tabSuggestionSchema }),
  /** An attachment finished extracting, or failed (spec 2026-09-26 §5.5): the chip updates its status. */
  z.object({ type: z.literal('attachment_status'), user_id: z.string(), conversation_id: z.string(), attachment: chatAttachment }),
  /** A subagent started, changed status or was interrupted: the panel's row. */
  z.object({ type: z.literal('subagent'), user_id: z.string(), conversation_id: z.string(), subagent: subagentViewSchema }),
  /** A cancel did not happen: the row is running again ("Não foi possível cancelar"). */
  z.object({ type: z.literal('subagent_cancel_failed'), user_id: z.string(), conversation_id: z.string(), subagent_id: z.string() }),
  /** How full the conversation's CLI session is (TER-315): after a turn or a compaction. */
  z.object({ type: z.literal('context'), user_id: z.string(), conversation_id: z.string(), tokens: z.number(), window: z.number().nullable() }),
  /** "Compactar" (TER-315): started, done or failed. */
  z.object({
    type: z.literal('compact'),
    user_id: z.string(),
    conversation_id: z.string(),
    state: z.enum(['started', 'done', 'failed']),
    tokens_before: z.number().nullable(),
    tokens: z.number().nullable(),
    error_code: z.string().nullable(),
  }),
  z.object({
    type: z.literal('run_finished'),
    user_id: z.string(),
    conversation_id: z.string(),
    message_id: z.string().nullable(),
    ok: z.boolean(),
    error_code: z.string().nullable(),
  }),
]);
