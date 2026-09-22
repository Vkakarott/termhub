import type { Repositories } from '../db/repositories/index.js';
import { probeTmuxSessionsCached } from '../terminal/machine-exec.js';
import { toPublicCity, type PublicCity } from './city.js';

/**
 * The one read behind both public surfaces: a nickname, the machines its owner has, and only the
 * projects that are published. Never probes a machine fresh — an anonymous visitor must not be able
 * to make this server open ssh connections; the memoised probe is what the office already warms.
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
    const probe = tabs.some((t) => t.kind === 'terminal') ? await probeTmuxSessionsCached(machine, { fresh: false }) : { reachable: true, sessions: new Set<string>() };
    buildings.push({
      machine,
      rooms: projects.map((project) => ({
        project,
        tabs: tabs.filter((t) => t.project_id === project.id).map((tab) => ({ tab, alive: probe.reachable && !!tab.tmux_session && probe.sessions.has(tab.tmux_session), progress: null })),
      })),
    });
  }
  if (buildings.length === 0) return undefined;
  return toPublicCity({ nickname, ownerName: owner.name, buildings });
}
