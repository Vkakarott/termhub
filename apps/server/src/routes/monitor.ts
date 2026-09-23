import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';

export interface MonitorItem {
  tab: Tab;
  project: Project;
  machine: Machine;
}

/** Monitor: every tab in the scope whose tool reported a state, newest change first. */
export async function monitorRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/tabs', async (request) => {
    const owner = request.scope.ownerId;
    const [tabs, projects, machines] = await Promise.all([repos.tabs.listWithState(owner), repos.projects.list({ owner }), repos.machines.list(owner)]);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const items: MonitorItem[] = [];
    for (const tab of tabs) {
      const project = projectById.get(tab.project_id);
      const machine = machineById.get(tab.machine_id);
      if (project && machine) items.push({ tab, project, machine });
    }
    return { items };
  });
}
