import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import type { Repositories } from '../db/repositories/index.js';
import { config } from '../config.js';

const listQuery = z.object({ q: z.string().trim().max(200).optional(), cursor: z.string().max(500).optional() });
const idParam = z.object({ id: z.string().min(1).max(64) });
const memoryBody = z.object({ enabled: z.boolean() });

/** 50 decisions per page (spec 2026-09-26 §4.6). */
export const DECISIONS_PAGE = 50;

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

/** "Memória do chat" (spec 2026-09-26 §4.6): the user's own decisions and the suggestion switch. Mounted
 * by both the web chat and the phone's, under the `chat` resource; always the signed-in user's rows —
 * `PATCH /memory` and `DELETE /decisions/:id` only ever touch the requester's own memory, so the
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
    // `false` when embeddings are not configured on this server at all: the switch has nothing to do.
    available: config.embeddings !== null,
    count: await repos.chatDecisions.countForUser(userId),
  });
  app.get('/memory', async (request) => memory(request.scope.user.id));
  app.patch('/memory', async (request) => {
    const { enabled } = memoryBody.parse(request.body);
    await repos.users.setChatSuggestions(request.scope.user.id, enabled);
    return memory(request.scope.user.id);
  });
}
