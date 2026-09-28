import { z } from 'zod';
import { MAX_ATTACHMENTS_PER_MESSAGE } from './attachments.js';
import { tabQuestionSchema } from './events.js';

/** `POST chat/messages`: text, or attachments, or both (spec 2026-09-26 §5.5). An empty text with ids
 * is a message made of files alone; neither is refused before anything is stored. */
export const mobileMessageBody = z
  .object({
    text: z.string().trim().max(8000).default(''),
    project_id: z.string().min(1).max(64).nullish(),
    attachment_ids: z.array(z.string().min(1).max(64)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  .refine((b) => b.text.length > 0 || (b.attachment_ids?.length ?? 0) > 0, { message: 'Escreva uma mensagem ou anexe um arquivo', path: ['text'] });
export const sendAccepted = z.object({ conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string() });
const proof = { challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) };

export const mobileDecisionBody = z
  .discriminatedUnion('decision', [
    z.object({ decision: z.literal('deny') }),
    /** A `write` card approves with the session alone; an irreversible one needs the PIN proof (the server decides). */
    z.object({ decision: z.literal('approve'), challenge: proof.challenge.optional(), pin_proof: proof.pin_proof.optional() }),
    /** Approve *and* trust the tab for send_input in this conversation (24 h max). Always PIN-proven. */
    z.object({ decision: z.literal('approve_tab'), ...proof }),
    /** Approve *and* trust the project's board in this conversation (24 h max). Always PIN-proven. */
    z.object({ decision: z.literal('approve_project'), ...proof }),
    /** Approve *and* trust the tab for send_key and send_input in this conversation (24 h max, spec
     * 2026-09-27 TER-325). Always PIN-proven. */
    z.object({ decision: z.literal('approve_tab_terminal'), ...proof }),
    /** Approve *and* trust the project's board and its tabs' keys and typing in this conversation (24 h
     * max, spec 2026-09-27 TER-325). Always PIN-proven. */
    z.object({ decision: z.literal('approve_project_all'), ...proof }),
  ])
  .refine((b) => b.decision !== 'approve' || (b.challenge === undefined) === (b.pin_proof === undefined), { message: 'challenge e pin_proof vão juntos' });

/** A grouped confirmation from the phone (spec 2026-09-26 §7). Each approval follows the single
 * decision's rule (TER-92): a `write` card approves with the session alone, an irreversible one
 * carries its own proof, bound to that action and the word `approve` (the server decides). There is
 * no `approve_tab`, `approve_project`, `approve_tab_terminal` nor `approve_project_all` here: "Permitir
 * sempre" and "Liberar" are always a single, PIN-proven decision. */
export const mobileBatchDecisionBody = z.object({
  decisions: z
    .array(
      z.discriminatedUnion('decision', [
        z.object({ id: z.string().min(1).max(64), decision: z.literal('deny') }),
        z.object({ id: z.string().min(1).max(64), decision: z.literal('approve'), challenge: proof.challenge.optional(), pin_proof: proof.pin_proof.optional() }),
      ]),
    )
    .min(1)
    .max(20)
    .refine((d) => new Set(d.map((x) => x.id)).size === d.length, 'Ações repetidas')
    .refine((d) => d.every((x) => x.decision !== 'approve' || (x.challenge === undefined) === (x.pin_proof === undefined)), 'challenge e pin_proof vão juntos'),
});

/** Mirrors the server's `grantable` (apps/server/src/chat/gate.ts), which is the judge: only
 * `send_input` to a tab, never answering a permission. Decides whether the card offers the button. */
export function isTabGrantable(action: { tool: string; args: unknown; tab_id: string | null }): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return action.tool === 'send_input' && args.answering_permission !== true && Boolean(action.tab_id);
}

/** Mirrors the server's `terminalGrantable` (apps/server/src/chat/gate.ts), which is the judge:
 * `send_input` or `send_key` to a tab, never answering a permission. Decides whether the card offers
 * "Liberar teclas e shell nesta aba" (spec 2026-09-27 TER-325). */
export function isTerminalGrantable(action: { tool: string; args: unknown; tab_id: string | null }): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return (action.tool === 'send_input' || action.tool === 'send_key') && args.answering_permission !== true && Boolean(action.tab_id);
}

/** Mirrors the server's `BOARD_GRANT_TOOLS` (apps/server/src/chat/gate.ts); the server is the judge
 * and refuses a card whose project does not resolve. */
export const BOARD_GRANT_TOOLS = ['create_task', 'add_subtasks', 'update_task', 'move_task'] as const;
export const isBoardGrantable = (action: { tool: string }): boolean => (BOARD_GRANT_TOOLS as readonly string[]).includes(action.tool);

export const chatProjectItem = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  busy: z.boolean(),
  pending_confirmations: z.number().int(),
  last_message_at: z.string().nullable(),
});
export const chatProjectsResponse = z.object({ projects: z.array(chatProjectItem) });
export const hostOptionsResponse = z.object({
  machines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      online: z.boolean(),
      agent_version: z.string().nullable(),
      accounts: z.array(z.object({ id: z.string(), label: z.string(), config_dir: z.string().nullable() })),
    })
  ),
});

/** `POST chat/tab-questions/:id/answer`. The server checks it against the question itself (count,
 * options, one of picked/typed); this is the shape the app sends. No PIN (spec 2026-09-25 §2). */
export const tabQuestionAnswerBody = z.union([
  z.object({ answers: z.array(z.object({ selected: z.array(z.number().int().min(0).max(3)).max(4), text: z.string().max(2000).optional() })).min(1).max(4) }),
  z.object({ allow: z.boolean(), text: z.string().max(2000).optional() }),
]);
/** `POST chat/tab-questions/:id/auto-answer/cancel` (no body): "Cancelar" on a countdown (spec 2026-09-26
 * concierge memory §6). Answers the card, `auto_answer.status: 'cancelled'`, the proposed answer kept as
 * the pre-selection; 404 for a card not the user's, 409 `NOT_SCHEDULED` when no countdown runs. "Responder
 * agora" is the ordinary answer route, which cancels the countdown itself. */
export const tabQuestionAutoAnswerCancelResponse = z.object({ tab_question: tabQuestionSchema });
/** `GET chat/tab-questions/:id/screen`: the last lines of the tab, live, for a permission card. */
export const tabQuestionScreenResponse = z.object({ text: z.string() });

/** `POST chat/tab-suggestions/:id/send`: the text to type, as edited. The server is the judge of the rest
 * (one line, no control characters, no leading "!" or "/"). No PIN (spec 2026-09-25 tab suggestions §2). */
export const tabSuggestionSendBody = z.object({ text: z.string().trim().min(1).max(2000) });

/** "Memória do chat" (spec 2026-09-26 §4.6): the shape of one remembered decision, as the list and
 * (eventually) other screens show it — never the embedding, the owning user, the conversation or the
 * tab question it came from. */
export const decisionOptionView = z.object({ label: z.string(), description: z.string() });
export const decisionAnswerView = z.object({ labels: z.array(z.string()), text: z.string().optional() });
export const decisionViewSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  header: z.string(),
  question: z.string(),
  options: z.array(decisionOptionView),
  multi_select: z.boolean(),
  answer: decisionAnswerView,
  suggested_count: z.number().int(),
  accepted_count: z.number().int(),
  created_at: z.string(),
});
/** `GET chat/decisions`: newest first, 50 per page, with a keyset `next_cursor` (opaque, `null` on the
 * last page). */
export const decisionsResponse = z.object({ decisions: z.array(decisionViewSchema), next_cursor: z.string().nullable() });

/** `GET`/`PATCH chat/memory`: the suggestion switch, "Responder sozinho quando houver precedente"
 * (spec D8), whether embeddings are configured on this server at all (`available: false` hides both
 * switches rather than offering ones that can never do anything), how many decisions are remembered,
 * and how many concierge notes (spec D12) are. */
export const chatMemoryResponse = z.object({ enabled: z.boolean(), autodecide: z.boolean(), available: z.boolean(), count: z.number().int(), notes: z.number().int() });
/** At least one of the two switches, never neither — an empty body is refused rather than a silent no-op. */
export const chatMemoryPatchBody = z
  .object({ enabled: z.boolean().optional(), autodecide: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.autodecide !== undefined, { message: 'Informe enabled ou autodecide' });

/** "Anotações do concierge" (spec D12/§8): one `record_decision` note, as the list shows it —
 * `question` is the note's title; `decision`/`reason` are parsed back out of the stored text's
 * `Decisão:`/`Motivo:` lines server-side (never the embedding, the owning user or the raw text). */
export const conciergeNoteView = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  question: z.string(),
  decision: z.string(),
  reason: z.string(),
  created_at: z.string(),
});
/** `GET chat/notes`: newest first, 50 per page, with a keyset `next_cursor` (opaque, `null` on the
 * last page) — the same pagination shape as `decisionsResponse`. */
export const notesResponse = z.object({ notes: z.array(conciergeNoteView), next_cursor: z.string().nullable() });

/** "Lições" (spec 2026-09-27 failure lessons §6/§8): one `lesson` item (chunk 0), as the "Lições" list
 * (and the verify/unverify routes, which answer the same shape) show it — never the embedding, the
 * owning user, `source_id` or the raw `meta`. `project` is `null` for an orphaned project; `path`,
 * `tab_id`, `card` and `pr` are `null` when the lesson (or its origin) has none. */
export const lessonItemSchema = z.object({
  id: z.string(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  title: z.string(),
  excerpt: z.string(),
  origin: z.enum(['file', 'note']),
  path: z.string().nullable(),
  tab_id: z.string().nullable(),
  card: z.string().nullable(),
  pr: z.string().nullable(),
  evidence: z.enum(['observed', 'fixed', 'confirmed']),
  verified: z.boolean(),
  verified_at: z.string().nullable(),
  created_at: z.string(),
});
/** `GET chat/lessons`: newest `source_at` first, with a keyset `next_cursor` — the same pagination
 * shape as `decisionsResponse`/`notesResponse`. */
export const lessonListSchema = z.object({ lessons: z.array(lessonItemSchema), next_cursor: z.string().nullable() });
/** `DELETE chat/lessons/:id` ("Esquecer"): `note` is present only for a file lesson, saying the file
 * itself stays in the repository until a PR removes it. */
export const lessonForgetSchema = z.object({ ok: z.literal(true), note: z.string().optional() });
