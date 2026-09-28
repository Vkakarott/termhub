import type { FastifyInstance } from 'fastify';
import { readinessCheck, type Lifecycle } from '../ws/drain.js';

/**
 * `/ready` (spec 2026-09-27 §5.1): what the deploy script and the Docker healthcheck poll. Unlike `/health`
 * it answers 503 once the database stops answering or this process started draining for a shutdown.
 */
export async function readyRoutes(app: FastifyInstance, deps: { ping: () => Promise<unknown>; lifecycle: Lifecycle }): Promise<void> {
  app.get('/ready', { config: { public: true } }, async (_req, reply) => {
    const r = await readinessCheck(deps.ping, deps.lifecycle);
    return reply.code(r.status).send(r.body);
  });
}
