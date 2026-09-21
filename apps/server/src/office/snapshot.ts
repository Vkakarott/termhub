import type { Machine, OfficeProgress, OfficeTabProgress, OfficeTaskCounts, Project, Tab } from '../db/repositories/types.js';

export interface OfficeTab extends Tab {
  alive: boolean;
  progress: OfficeTabProgress | null;
}

export interface OfficeRoom {
  project: Project;
  tabs: OfficeTab[];
  /** null = the person cannot read tasks */
  tasks: OfficeTaskCounts | null;
}

export interface OfficeSnapshot {
  machine: Machine;
  /** false = the machine could not be asked which tmux sessions exist; every terminal tab reads as not alive */
  reachable: boolean;
  rooms: OfficeRoom[];
}

/**
 * The floor of one machine: a room per non-archived project (in the order given — the repository
 * sorts by name, like the sidebar), its tabs, and the board's progress when the person may see it.
 * Pure: the route does the loading. It carries the same Project/Machine/Tab records the person
 * already receives from /projects, /machines and /monitor, plus task counts — no terminal content,
 * and the route logs nothing beyond ids and counts.
 */
export function buildOfficeSnapshot(input: {
  machine: Machine;
  projects: Project[];
  tabs: Tab[];
  aliveSessions: Set<string>;
  reachable: boolean;
  simulatorReady: (udid: string) => boolean;
  progress: OfficeProgress | null;
}): OfficeSnapshot {
  const tabsByProject = new Map<string, Tab[]>();
  for (const t of input.tabs) tabsByProject.set(t.project_id, [...(tabsByProject.get(t.project_id) ?? []), t]);
  const rooms = input.projects
    .filter((p) => p.status !== 'archived')
    .map((project) => ({
      project,
      tasks: input.progress ? (input.progress.counts[project.id] ?? { todo: 0, doing: 0, done: 0 }) : null,
      tabs: (tabsByProject.get(project.id) ?? []).map((t) => ({
        ...t,
        alive: t.kind === 'simulator' ? !!t.simulator_udid && input.simulatorReady(t.simulator_udid) : input.reachable && !!t.tmux_session && input.aliveSessions.has(t.tmux_session),
        progress: input.progress?.byTab[t.id] ?? null,
      })),
    }));
  return { machine: input.machine, reachable: input.reachable, rooms };
}
