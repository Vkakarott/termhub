import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccess } from '../auth/permissions.js';
import { scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import { buildOfficeSnapshot } from '../office/snapshot.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { listTmuxSessions } from '../terminal/machine-exec.js';

const params = z.object({ machineId: z.string().min(1).max(64) });

/**
 * The office view's one read: a machine's floor (projects, tabs, board progress). Registered under
 * the `projects` resource; the board part additionally needs `tasks:read` and is left out — not
 * even queried — without it.
 */
export async function officeRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: Pick<SimulatorSessionManager, 'isReady'> }) {
  app.get('/:machineId', async (request) => {
    const { machineId } = params.parse(request.params);
    const machine = await scoped(repos, request).machine(machineId);
    const projects = await repos.projects.list({ machine_id: machine.id });
    const projectIds = projects.filter((p) => p.status !== 'archived').map((p) => p.id);
    const [tabs, progress] = await Promise.all([
      repos.tabs.listByProjects(projectIds),
      (await canAccess(repos, request.user, 'tasks', 'read')) ? repos.tasks.officeProgress(projectIds) : Promise.resolve(null),
    ]);
    let aliveSessions = new Set<string>();
    let reachable = true;
    if (tabs.some((t) => t.kind === 'terminal')) {
      try {
        aliveSessions = await listTmuxSessions(machine);
      } catch {
        reachable = false;
      }
    }
    request.log.info({ machineId: machine.id, rooms: projectIds.length, tabs: tabs.length, reachable }, 'office: snapshot');
    return buildOfficeSnapshot({ machine, projects, tabs, aliveSessions, reachable, simulatorReady: (udid) => deps.simulators.isReady(machine.id, udid), progress });
  });
}
