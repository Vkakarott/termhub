import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatService } from '../chat/service.js';
import { chatBus } from '../chat/bus.js';
import { conflict, notFound } from '../lib/errors.js';

const messageBody = z.object({ text: z.string().trim().min(1).max(8000) });
const actionIdParam = z.object({ id: z.string().min(1).max(64) });
const decisionBody = z.object({ decision: z.enum(['approve', 'deny']) });

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
      // Telling "not found" apart from "already decided" without a second ownership check: look at
      // this user's own conversation (the same boundary `decide` used) rather than at the row's
      // owner, so a wrong id or another user's row still reads as 404 and only a settled row of this
      // user's reads as 409. The limit is large rather than absent so a long-lived conversation's
      // older decided rows are not misread as "not found"; this only runs on the error path.
      const conversation = await deps.service.conversationFor(user);
      const alreadyMine = (await repos.chatActions.listByConversation(conversation.id, 1_000_000)).some((a) => a.id === id);
      throw alreadyMine ? conflict('Esta ação já foi decidida') : notFound('Ação não encontrada');
    }

    // Every open tab must see the decision, not only the one that clicked it.
    chatBus.publish({ type: 'decision', user_id: user.id, action_id: action.id, status });

    const message = await deps.service.resumeAfterDecision(user, action);
    return { action, message };
  });
}
