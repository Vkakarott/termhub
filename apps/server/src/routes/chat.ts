import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatService } from '../chat/service.js';
import { chatBus } from '../chat/bus.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';

const messageBody = z.object({ text: z.string().trim().min(1).max(8000) });
const actionIdParam = z.object({ id: z.string().min(1).max(64) });
const decisionBody = z.object({ decision: z.enum(['approve', 'deny']) });

/** What a busy-run decision answers with: the decision is already durably recorded (`decide` ran
 * and the bus already published it) before this is ever reached, so a 409 here would tell the
 * client its own successful decision was a conflict. `ChatService.drainNextDecision` injects it as
 * soon as the run that is currently using the conversation's lock finishes — no client action needed. */
const QUEUED_NOTE = 'A decisão foi registrada e será aplicada assim que a resposta atual do concierge terminar.';

/** REST surface for the concierge chat: the conversation, its history and sending a message.
 * Live updates (deltas, actions) travel over `/ws/chat`, not here. */
export async function chatRoutes(app: FastifyInstance, repos: Repositories, deps: { service: ChatService }) {
  app.get('/', async (request) => {
    const conversation = await deps.service.conversationFor(request.scope.user);
    return { conversation, messages: await repos.chat.listMessages(conversation.id) };
  });

  app.post('/messages', { config: { action: 'create' } }, async (request, reply) => {
    const { text } = messageBody.parse(request.body);
    const message = await deps.service.send(request.scope.user, text);
    return reply.code(201).send({ message });
  });

  app.post('/actions/:id/decision', async (request) => {
    const { id } = actionIdParam.parse(request.params);
    const { decision } = decisionBody.parse(request.body);
    const status = decision === 'approve' ? 'approved' : 'denied';
    const user = request.scope.user;

    // The decision itself, and only it, decides who may answer this row — `decide` filters by the
    // owning conversation's user_id in SQL, so wrong id, another user's row and an already-decided
    // row of this user's all come back as `undefined` here, indistinguishably.
    const action = await repos.chatActions.decide(id, user.id, status);
    if (!action) {
      // Telling "not found" apart from "already decided": `findByIdForUser` is scoped by the same
      // owning-conversation `user_id` join `decide` uses, so this is not a second authorisation path
      // — it never says who owns a row it will not show, only whether one exists for this user.
      const existing = await repos.chatActions.findByIdForUser(id, user.id);
      throw existing ? conflict('Esta ação já foi decidida') : notFound('Ação não encontrada');
    }

    // Every open tab must see the decision, not only the one that clicked it.
    chatBus.publish({ type: 'decision', user_id: user.id, action_id: action.id, status });

    try {
      const message = await deps.service.resumeAfterDecision(user, action);
      return { action, message };
    } catch (err) {
      // The decision above already happened and was already published — a busy run must not turn a
      // successful decision into a 409. The row stays approved/denied with no injection yet; the run
      // holding the lock will pick it up and inject it through `drainNextDecision` once it finishes.
      if (err instanceof HttpError && err.code === 'CHAT_BUSY') return { action, queued: true, note: QUEUED_NOTE };
      throw err;
    }
  });
}
