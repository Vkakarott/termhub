import { z } from 'zod';

/** Mirrors `ChatMessage` in `apps/server/src/db/repositories/chat.ts`. */
export const chatMessage = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  usage: z.unknown().nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
});

/** Mirrors `ChatActionClass` in `apps/server/src/db/repositories/chat-actions.ts`. */
export const chatActionClass = z.enum(['read', 'write', 'irreversible']);

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
    created_at: z.string(),
  }),
  z.object({ type: z.literal('decision'), user_id: z.string(), conversation_id: z.string(), action_id: z.string(), status: z.enum(['approved', 'denied']) }),
]);
