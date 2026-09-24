import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agent/registry.js';
import { canAccess } from '../auth/permissions.js';
import type { Repositories } from '../db/repositories/index.js';
import { buildOfficeCity } from '../office/snapshot.js';
import type { SimulatorSessionManager } from '../simulator/session-manager.js';
import { probeTmuxSessionsCached, type TmuxProbe } from '../terminal/machine-exec.js';

const query = z.object({ fresh: z.enum(['0', '1']).optional() });

/**
 * The office view's one read: the whole city — every non-archived project of the scope as a
 * building, all of its tabs whatever machine they run on, and those machines. Registered under the
 * `projects` resource; the board part additionally needs `tasks:read` and is left out — not even
 * queried — without it. A tab on a machine outside the scope is not a desk: the scope would 404 it
 * the moment someone clicked it (`scoped(...).tab`). Every machine with a terminal desk is probed
 * once, all in parallel, so the answer waits for the slowest one, bounded by the probe's own
 * timeouts; the probe is memoised per machine (see `probeTmuxSessionsCached`), so every browser tab
 * polling once a minute shares one round-trip per machine, and `?fresh=1` bypasses that memo for a
 * tab that was just opened. A probe that fails outright marks its machine unreachable, never the
 * whole read.
 */
export async function officeRoutes(app: FastifyInstance, repos: Repositories, deps: { simulators: Pick<SimulatorSessionManager, 'isReady'>; agents: Pick<AgentRegistry, 'isOnline'> }) {
  app.get('/', async (request) => {
    const { fresh } = query.parse(request.query);
    const owner = request.scope.ownerId;
    const projects = (await repos.projects.list({ owner })).filter((p) => p.status !== 'archived');
    const projectIds = projects.map((p) => p.id);
    const [allTabs, scopeMachines, progress] = await Promise.all([
      repos.tabs.listByProjects(projectIds),
      repos.machines.list(owner),
      (await canAccess(repos, request.user, 'tasks', 'read')) ? repos.tasks.officeProgress(projectIds) : Promise.resolve(null),
    ]);
    const inScope = new Map(scopeMachines.map((m) => [m.id, m]));
    const tabs = allTabs.filter((t) => inScope.has(t.machine_id));
    const machines = [...new Set(tabs.map((t) => t.machine_id))].map((id) => inScope.get(id)!);
    const probed = machines.filter((m) => tabs.some((t) => t.machine_id === m.id && t.kind === 'terminal'));
    const probes = new Map<string, TmuxProbe>(
      await Promise.all(
        probed.map(async (machine) => {
          // the probe answers `reachable: false` for the usual ways a machine goes silent; a throw (a
          // misconfigured machine, a bug) must still be one silent machine, not a failed city
          const probe = await probeTmuxSessionsCached(machine, { fresh: fresh === '1' }).catch((): TmuxProbe => ({ reachable: false, sessions: new Set(), cause: 'probe failed' }));
          if (!probe.reachable) request.log.warn({ machineId: machine.id, cause: probe.cause }, 'office: machine unreachable');
          return [machine.id, probe] as const;
        }),
      ),
    );
    request.log.debug({ buildings: projects.length, tabs: tabs.length, machines: machines.length, probed: probed.length }, 'office: city');
    return buildOfficeCity({
      projects,
      tabs,
      machines,
      probes,
      agentOnline: (id) => deps.agents.isOnline(id),
      simulatorReady: (machineId, udid) => deps.simulators.isReady(machineId, udid),
      progress,
    });
  });
}
