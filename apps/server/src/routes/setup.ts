import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { setupSchema } from '../setup/schema.js';
import { syncProjectTickets } from '../setup/tickets-sync.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** Montado em /projects: setup do projeto e sync de tickets. */
export async function setupRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    return { setup: await repos.projectSetup.get(id) };
  });

  app.put('/:id/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const data = setupSchema.parse(request.body);
    const s = scoped(repos, request);
    const exists = (p: Promise<unknown>) => p.then(() => true, () => false);
    if (data.tickets && !(await exists(s.integration(data.tickets.integration_id)))) throw badRequest('Integração de tickets inexistente');
    if (data.repo?.integration_id && !(await exists(s.integration(data.repo.integration_id)))) throw badRequest('Integração do repositório inexistente');
    if (data.runner.machine_id && !(await exists(s.machine(data.runner.machine_id)))) throw badRequest('Máquina do runner inexistente');
    return { setup: await repos.projectSetup.save(id, data) };
  });

  app.post('/:id/tickets/sync', { config: { resource: 'tickets', action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const setup = await repos.projectSetup.get(id);
    if (!setup.data.tickets) throw badRequest('Configure a fonte de tickets no setup do projeto');
    const result = await syncProjectTickets(repos, id, setup.data.tickets);
    return { ok: true, ...result };
  });
}
