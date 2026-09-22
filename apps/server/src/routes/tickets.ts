import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { getProvider } from '../integrations/index.js';
import { externalId, ticketRef } from '../setup/tickets-sync.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const importBody = z.object({ ticket_ids: z.array(z.string().min(1).max(64)).min(1).max(200) });
const terminalBody = z.object({ machine_id: z.string().min(1).max(64).optional() }).strict();

/** Montado em /projects: lista de tickets sincronizados e importação para o backlog. */
export async function projectTicketRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/tickets', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const q = z.object({ integration_id: z.string().max(64).optional() }).parse(request.query);
    return { tickets: await repos.tickets.listByProject(id, q.integration_id) };
  });

  /** Manda tickets escolhidos para o backlog (cria tasks vinculadas). */
  app.post('/:id/tickets/import', { config: { resource: 'tasks', action: 'create' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const { ticket_ids } = importBody.parse(request.body);
    const tickets = await repos.tickets.findByIds(id, ticket_ids);
    const created = [];
    for (const t of tickets) {
      if (t.task_id) continue;
      const task = await repos.tasks.createFromTicket(id, {
        key: t.external_key,
        title: `${t.identifier} ${t.title}`.trim(),
        description: t.description,
        ref: ticketRef(
          { provider: t.provider, id: externalId(t.external_key, t.provider), identifier: t.identifier, url: t.url, state: t.state, status: t.status, updatedAt: String(t.meta.updated_at ?? ''), meta: t.meta },
          String(t.meta.scope ?? ''),
        ),
      });
      await repos.tickets.linkTask(t.id, task.id);
      created.push(task);
    }
    return { tasks: created };
  });
}

/** Montado em /tasks: ações que ligam a task ao ticket externo e ao terminal. */
export async function taskTicketRoutes(app: FastifyInstance, repos: Repositories) {
  /** Empurra a coluna atual da task para o provedor (ação explícita). */
  app.post('/:id/push-status', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { task } = await scoped(repos, request).task(id);
    const ref = task.external_ref as { provider?: string; id?: string; identifier?: string; scope?: string } | null;
    if (!ref?.provider || !ref.id) throw badRequest('Task não está ligada a um ticket externo');
    const setup = await repos.projectSetup.get(task.project_id);
    const source = setup.data.tickets;
    if (!source || source.provider !== ref.provider) throw badRequest('Fonte de tickets do projeto não corresponde ao ticket');
    const integration = await repos.integrations.findById(source.integration_id);
    const secret = await repos.integrations.getSecret(source.integration_id);
    if (!integration || !secret) throw badRequest('Integração não encontrada');
    let state: string;
    try {
      state = await getProvider(ref.provider).updateStatus(
        secret,
        integration.config,
        { id: ref.id, identifier: ref.identifier ?? ref.id, scope: ref.scope ?? source.scope },
        task.status,
      );
    } catch (e) {
      throw new HttpError(502, (e as Error).message, 'PROVIDER_ERROR');
    }
    const nextRef = { ...(task.external_ref as object), state, status: task.status, pushed_at: new Date().toISOString() };
    await repos.tasks.setExternalRef(id, nextRef);
    return { task: await repos.tasks.findById(id), state };
  });

  /** Abre (ou reaproveita) uma tab de terminal para a task e a vincula. */
  app.post('/:id/terminal', { config: { resource: 'terminals', action: 'create' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { task } = await scoped(repos, request).task(id);
    if (task.tab_id) {
      const existing = await repos.tabs.findById(task.tab_id);
      if (existing) return { task, tab: existing, created: false };
    }
    // Same contract as `POST /projects/:id/tabs`: with one linked machine it is used; with several,
    // `machine_id` is required (400 MACHINE_REQUIRED); with none, 400 NO_MACHINE (see `projectMachineFor`).
    const { machine_id } = terminalBody.parse(request.body ?? {});
    const { machine } = await scoped(repos, request).projectMachineFor(task.project_id, machine_id);
    const ref = task.external_ref as { identifier?: string } | null;
    const name = (ref?.identifier ?? task.title).slice(0, 40);
    const tab = await repos.tabs.create(task.project_id, machine.id, name);
    const updated = await repos.tasks.setTab(id, tab.id);
    return { task: updated, tab, created: true };
  });

  app.delete('/:id/terminal', { config: { resource: 'tasks', action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).task(id);
    return { task: await repos.tasks.setTab(id, null) };
  });
}
