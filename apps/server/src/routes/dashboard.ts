import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';

/** Visão "o que estou fazendo agora": projetos ativos + máquina + tasks em andamento + último terminal. */
export async function dashboardRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async (request) => {
    const owner = request.scope.ownerId;
    const [projects, machines, doing, openCounts] = await Promise.all([
      repos.projects.list({ status: 'active', owner }),
      repos.machines.list(owner),
      repos.tasks.listDoing(owner),
      repos.tasks.openCountByProject(),
    ]);
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const items = projects
      .map((p) => ({
        project: p,
        machine: machineById.get(p.machine_id) ?? null,
        doing: doing.filter((t) => t.project_id === p.id),
        open_tasks: openCounts[p.id] ?? 0,
      }))
      .sort((a, b) => (b.project.last_terminal_at ?? '').localeCompare(a.project.last_terminal_at ?? ''));
    return { items };
  });
}
