import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';

/** Visão "o que estou fazendo agora": active projects + their machines + tasks in progress + last terminal. */
export async function dashboardRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async (request) => {
    const owner = request.scope.ownerId;
    const [projects, machines, doing, openCounts] = await Promise.all([
      repos.projects.list({ status: 'active', owner }),
      repos.machines.list(owner),
      repos.tasks.listDoing(owner),
      repos.tasks.openCountByProject(),
    ]);
    const links = await repos.projectMachines.listByProjects(projects.map((p) => p.id));
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const items = projects
      .map((p) => ({
        project: p,
        machines: links
          .filter((l) => l.project_id === p.id)
          .map((l) => machineById.get(l.machine_id))
          .filter((m): m is NonNullable<typeof m> => !!m),
        doing: doing.filter((t) => t.project_id === p.id),
        open_tasks: openCounts[p.id] ?? 0,
      }))
      .sort((a, b) => (b.project.last_terminal_at ?? '').localeCompare(a.project.last_terminal_at ?? ''));
    return { items };
  });
}
