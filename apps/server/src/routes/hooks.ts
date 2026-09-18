import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { unauthorized } from '../lib/errors.js';
import { ingestHookEvent } from '../monitor/ingest.js';
import { HOOK_TOOLS } from '../monitor/state.js';
import { HOOK_TOKEN_PREFIX, hashHookToken } from '../monitor/token.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** machine authenticated by its hook token (hooks routes only) */
    hookMachineId?: string;
  }
}

/** Exported for the unit test: what the machines' hook script posts. */
export const hookEventBody = z.object({
  tool: z.enum(HOOK_TOOLS),
  /** tmux session the tool runs in (the script reads it from $TMUX_PANE) */
  session: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  /** the tool's raw hook payload; interpreted server-side */
  event: z.unknown(),
});

/** Codex includes the turn's input messages in its payload; keep room for that, nothing bigger. */
export const HOOK_BODY_LIMIT = 256 * 1024;

/**
 * Monitor ingestion. POST is public (no user session): the machines post here with the token
 * their hook install got — the proxy forwards termhub.dev/api/hooks/events to the app so the
 * calls do not go through Cloudflare Access. Only the token's hash is stored.
 */
export async function hooksRoutes(app: FastifyInstance, repos: Repositories) {
  /** Token check runs at onRequest, before the body is read: an unauthenticated caller never gets a JSON parse. */
  const authenticate = async (request: FastifyRequest) => {
    const auth = request.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token.startsWith(HOOK_TOKEN_PREFIX) || token.length > 128) throw unauthorized();
    const machineId = await repos.machineHooks.machineIdForTokenHash(hashHookToken(token));
    if (!machineId) throw unauthorized();
    request.hookMachineId = machineId;
  };

  app.post('/events', { config: { public: true }, bodyLimit: HOOK_BODY_LIMIT, onRequest: authenticate }, async (request, reply) => {
    const machineId = request.hookMachineId;
    if (!machineId) throw unauthorized();

    const body = hookEventBody.parse(request.body);
    const result = await ingestHookEvent(repos, request.log, { machineId, tool: body.tool, session: body.session, event: body.event });
    if (!result.ok) return reply.code(202).send({ ok: false, reason: result.reason });
    return { ok: true, tab_id: result.tab.id, state: result.tab.state };
  });
}
