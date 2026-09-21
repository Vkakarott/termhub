import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccess } from '../auth/permissions.js';
import { scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import { buildOfficeSnapshot } from '../office/snapshot.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { probeTmuxSessionsCached } from '../terminal/machine-exec.js';

const params = z.object({ machineId: z.string().min(1).max(64) });
const query = z.object({ fresh: z.enum(['0', '1']).optional() });

/**
 * The office view's one read: a machine's floor (projects, tabs, board progress). Registered under
 * the `projects` resource; the board part additionally needs `tasks:read` and is left out — not
 * even queried — without it. The tmux probe is memoised per machine (see `probeTmuxSessionsCached`)
 * so an account's tabs polling every machine once a minute share one round-trip per machine;
 * `?fresh=1` bypasses that memo and refreshes it, for a tab that was just opened.
 */
export async function officeRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: Pick<SimulatorSessionManager, 'isReady'> }) {
  app.get('/:machineId', async (request) => {
    const { machineId } = params.parse(request.params);
    const { fresh } = query.parse(request.query);
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
      // the probe, not listTmuxSessions: a silent machine must not read as "every tab closed"
      const probe = await probeTmuxSessionsCached(machine, { fresh: fresh === '1' });
      ({ reachable, sessions: aliveSessions } = probe);
      if (!reachable) request.log.warn({ machineId: machine.id, cause: probe.cause }, 'office: machine unreachable');
    }
    request.log.debug({ machineId: machine.id, rooms: projectIds.length, tabs: tabs.length, reachable }, 'office: snapshot');
    return buildOfficeSnapshot({ machine, projects, tabs, aliveSessions, reachable, simulatorReady: (udid) => deps.simulators.isReady(machine.id, udid), progress });
  });
}
