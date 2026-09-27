import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import type { MemoryItem } from '../db/repositories/memory-items.js';
import type { Repositories } from '../db/repositories/index.js';
import { config } from '../config.js';
import { publishTabQuestions } from '../chat/tab-questions.js';

const listQuery = z.object({ q: z.string().trim().max(200).optional(), cursor: z.string().max(500).optional() });
const notesQuery = z.object({ cursor: z.string().max(500).optional() });
const idParam = z.object({ id: z.string().min(1).max(64) });
/** `PATCH /memory` (spec D8/§8): at least one of the two switches, never neither — an empty body is a
 *  400, not a silent no-op. */
const memoryBody = z
  .object({ enabled: z.boolean().optional(), autodecide: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.autodecide !== undefined, { message: 'Informe enabled ou autodecide' });

/** 50 decisions per page (spec 2026-09-26 §4.6). */
export const DECISIONS_PAGE = 50;
/** 50 notes per page (task-10 brief), same page size as decisions. */
export const NOTES_PAGE = 50;

/** The wire shape of one remembered decision: every `ChatDecision` column but `user_id`,
 * `conversation_id`, `tab_question_id`, `question_index` and `embed_model` — none of which the
 * "Memória do chat" screen shows, and the last two of which are implementation detail. */
function toDecisionView(d: ChatDecision) {
  return {
    id: d.id,
    project_id: d.project_id,
    project_name: d.project_name,
    header: d.header,
    question: d.question,
    options: d.options,
    multi_select: d.multi_select,
    answer: d.answer,
    suggested_count: d.suggested_count,
    accepted_count: d.accepted_count,
    created_at: d.created_at,
  };
}

/** Reverses `indexNote`'s stored `text` (`Decisão: …\nMotivo: …\nFontes: …`, see
 * `apps/server/src/memory/index-items.ts`) back into the two fields "Anotações do concierge" shows
 * in their own columns. A line missing (an old or malformed row, or one cut short by the 1200-char
 * limit) answers `''` for that field rather than throwing — the note still shows, just blank there. */
function parseNoteText(text: string): { decision: string; reason: string } {
  const lines = text.split('\n');
  const after = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? '';
  return { decision: after('Decisão: '), reason: after('Motivo: ') };
}

/** The wire shape of one concierge note (spec D12/§8): `question` is the note's `title`; `decision`
 *  and `reason` are parsed back out of `text`. Never the project id's owner, `source_id`, `trust` or
 *  any other memory-item column the "Anotações do concierge" list has no use for. */
function toNoteView(item: MemoryItem) {
  const { decision, reason } = parseNoteText(item.text);
  return {
    id: item.id,
    project_id: item.project_id,
    project_name: item.project_name,
    question: item.title,
    decision,
    reason,
    created_at: item.created_at,
  };
}

/** "Memória do chat" (spec 2026-09-26 §4.6, concierge memory D8/D12/§8): the user's own decisions, the
 * suggestion and "Responder sozinho" switches, and the concierge's own notes. Mounted by both the web
 * chat and the phone's, under the `chat` resource; always the signed-in user's rows — `PATCH /memory`,
 * `DELETE /decisions/:id` and `DELETE /notes/:id` only ever touch the requester's own memory, so the
 * ordinary `chat:update`/`chat:delete` grants (held by every role with the chat — BETA has full CRUD
 * on `chat`, migration 20260921233000_chat_beta_role) are enough; no `{ config: { action: 'read' } }`
 * override is needed here (see the task-6 report for the check). */
export async function chatMemoryRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/decisions', async (request) => {
    const { q, cursor } = listQuery.parse(request.query);
    const { items, next_cursor } = await repos.chatDecisions.listForUser(request.scope.user.id, { q: q || undefined, cursor, limit: DECISIONS_PAGE });
    return { decisions: items.map(toDecisionView), next_cursor };
  });

  /** Idempotent and silent about whether the id ever existed or was someone else's: `deleteForUser`
   * scopes the delete to this user in SQL, so there is nothing left to distinguish here. */
  app.delete('/decisions/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await repos.chatDecisions.deleteForUser(id, request.scope.user.id);
    return reply.code(204).send();
  });

  const memory = async (userId: string) => ({
    enabled: await repos.users.chatSuggestions(userId),
    // "Responder sozinho quando houver precedente" (spec D8): off by default, opt-in per user.
    autodecide: await repos.users.chatAutodecide(userId),
    // `false` when embeddings are not configured on this server at all: the switch has nothing to do.
    available: config.embeddings !== null,
    count: await repos.chatDecisions.countForUser(userId),
    // "Anotações do concierge" (spec D12): the ruling is `countNotesSince(userId, epoch)` — every note
    // this user has, not a windowed count.
    notes: await repos.memoryItems.countNotesSince(userId, new Date(0)),
  });
  app.get('/memory', async (request) => memory(request.scope.user.id));
  app.patch('/memory', async (request) => {
    const body = memoryBody.parse(request.body);
    const userId = request.scope.user.id;
    if (body.enabled !== undefined) await repos.users.setChatSuggestions(userId, body.enabled);
    if (body.autodecide !== undefined) await repos.users.setChatAutodecide(userId, body.autodecide);
    if (body.autodecide === false) {
      // Turning "Responder sozinho" off also stops what it already started: every countdown still
      // `scheduled` becomes `cancelled` (the card keeps its proposed answer as a pre-selection), and
      // every open screen hears it. After the switch is stored, so nothing new is scheduled behind it;
      // one already claimed (`sent`) is the sender's, which re-reads the switch and fails AUTODECIDE_OFF.
      const cancelled = await repos.tabQuestions.cancelScheduledForUser(userId);
      if (cancelled.length > 0) await publishTabQuestions(repos, 'tab_question', cancelled);
    }
    return memory(userId);
  });

  /** "Anotações do concierge" (spec D12/§8): newest first, 50 per page, keyset `cursor` like `/decisions`. */
  app.get('/notes', async (request) => {
    const { cursor } = notesQuery.parse(request.query);
    const { items, next_cursor } = await repos.memoryItems.listNotes(request.scope.user.id, { cursor, limit: NOTES_PAGE });
    return { notes: items.map(toNoteView), next_cursor };
  });

  /** "Esquecer": idempotent and silent about whether the id ever existed, was someone else's, or was
   * some other memory kind — `deleteNote` scopes to `(id, ownerId, kind: 'note')` in SQL, so there is
   * nothing left to distinguish here. */
  app.delete('/notes/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await repos.memoryItems.deleteNote(id, request.scope.user.id);
    return reply.code(204).send();
  });
}
