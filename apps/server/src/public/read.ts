import type { Repositories } from '../db/repositories/index.js';
import { cachedTmuxProbe } from '../terminal/machine-exec.js';
import { toPublicCity, type PublicCity } from './city.js';

/**
 * The one read behind both public surfaces: a nickname, the machines its owner has, and only the
 * projects that are published. This never initiates an ssh round-trip: it only ever *reads* the
 * tmux memo the office already warms (`cachedTmuxProbe`), and never calls the probing function that
 * would refresh it. When the memo is warm, a terminal tab's `alive` is real tmux session membership.
 * When it is cold — nobody with the office open recently, or the memo expired — the tab's own last
 * reported state stands in for it instead (a tab that never reported one reads as not alive):
 * an anonymous visitor must not be able to make this server dial an unreachable machine and wait out
 * its timeout, and a cold city showing every desk empty would be a worse answer than a stale one.
 */
export async function readPublicCity(repos: Repositories, nickname: string): Promise<PublicCity | undefined> {
  const owner = await repos.users.findByNickname(nickname);
  if (!owner) return undefined;
  const machines = await repos.machines.list(owner.id);
  const buildings = [];
  for (const machine of machines) {
    const projects = (await repos.projects.list({ machine_id: machine.id })).filter((p) => p.is_public && p.status !== 'archived');
    if (projects.length === 0) continue;
    const tabs = await repos.tabs.listByProjects(projects.map((p) => p.id));
    const probe = tabs.some((t) => t.kind === 'terminal') ? cachedTmuxProbe(machine) : undefined;
    buildings.push({
      machine,
      rooms: projects.map((project) => ({
        project,
        tabs: tabs.filter((t) => t.project_id === project.id).map((tab) => ({
          tab,
          alive: probe
            ? probe.reachable && !!tab.tmux_session && probe.sessions.has(tab.tmux_session)
            : tab.kind === 'terminal' && tab.state !== null,
          progress: null,
        })),
      })),
    });
  }
  if (buildings.length === 0) return undefined;
  return toPublicCity({ nickname, ownerName: owner.name, buildings });
}
