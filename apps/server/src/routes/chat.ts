import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatService } from '../chat/service.js';

const messageBody = z.object({ text: z.string().trim().min(1).max(8000) });

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
}
