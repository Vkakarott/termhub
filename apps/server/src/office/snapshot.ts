import { publicId } from '../public/public-id.js';
import type { Machine, MachineType, OfficeProgress, OfficeTabProgress, OfficeTaskCounts, Project, Tab } from '../db/repositories/types.js';
import type { TmuxProbe } from '../terminal/machine-exec.js';

export interface OfficeTab extends Tab {
  alive: boolean;
  progress: OfficeTabProgress | null;
}

/** One building of the office city: a project and every desk (tab) it has, whatever machine each runs on. */
export interface OfficeBuilding {
  project: Project;
  /** the building's id on the owner's public city (`publicId('project', id)`), for the share link */
  public_id: string;
  tabs: OfficeTab[];
  /** null = the person cannot read tasks */
  tasks: OfficeTaskCounts | null;
}

/** A machine one of the city's desks runs on: a detail of the desk (its tag, its offline state), never a building. */
export interface OfficeMachine {
  id: string;
  name: string;
  subtitle: string | null;
  type: MachineType;
  /** agent: connected now; local: always; ssh: its probe answered, or it was not asked */
  online: boolean;
  /** the tmux probe: false = it could not ask the machine; null = not probed (no terminal desk runs there) */
  reachable: boolean | null;
}

export interface OfficeCity {
  /** the scope's non-archived projects, in the order given (by name, like the sidebar), empty ones kept */
  projects: OfficeBuilding[];
  /** every machine a desk refers to */
  machines: OfficeMachine[];
}

/** Whether a machine is up: the rule the MCP's list_machines uses (control/inventory.ts), with the probe answering for ssh. */
export function machineOnline(machine: Pick<Machine, 'id' | 'type'>, probe: TmuxProbe | undefined, agentOnline: (machineId: string) => boolean): boolean {
  if (machine.type === 'agent') return agentOnline(machine.id);
  if (machine.type === 'local') return true;
  // nothing but the probe ever answers for an ssh machine; not asked counts as up, as "checking" does in the app
  return probe ? probe.reachable : true;
}

/**
 * The whole office: a building per non-archived project (in the order given — the repository sorts
 * by name, like the sidebar), each with every one of its tabs whatever machine it runs on, and the
 * machines those tabs run on. A terminal tab is alive when its own machine's probe reached tmux and
 * its session is there; a simulator tab when the simulator manager says so. Pure: the route does
 * the loading and the probing. It carries the same Project/Tab records the person already receives
 * from /projects and /monitor, a narrow view of each machine, and task counts — no terminal content.
 */
export function buildOfficeCity(input: {
  projects: Project[];
  tabs: Tab[];
  machines: Machine[];
  /** by machine id; a machine absent here was not probed */
  probes: Map<string, TmuxProbe>;
  agentOnline: (machineId: string) => boolean;
  simulatorReady: (machineId: string, udid: string) => boolean;
  progress: OfficeProgress | null;
}): OfficeCity {
  const tabsByProject = new Map<string, Tab[]>();
  for (const t of input.tabs) tabsByProject.set(t.project_id, [...(tabsByProject.get(t.project_id) ?? []), t]);
  const alive = (t: Tab): boolean => {
    if (t.kind === 'simulator') return !!t.simulator_udid && input.simulatorReady(t.machine_id, t.simulator_udid);
    const probe = input.probes.get(t.machine_id);
    return !!probe?.reachable && !!t.tmux_session && probe.sessions.has(t.tmux_session);
  };
  const projects = input.projects
    .filter((p) => p.status !== 'archived')
    .map((project) => ({
      project,
      public_id: publicId('project', project.id),
      tasks: input.progress ? (input.progress.counts[project.id] ?? { todo: 0, doing: 0, done: 0 }) : null,
      tabs: (tabsByProject.get(project.id) ?? []).map((t) => ({ ...t, alive: alive(t), progress: input.progress?.byTab[t.id] ?? null })),
    }));
  // named field by field: a machine is a detail of a desk here, not the whole record (host, ssh user…)
  const machines = input.machines.map((m): OfficeMachine => {
    const probe = input.probes.get(m.id);
    return { id: m.id, name: m.name, subtitle: m.subtitle, type: m.type, online: machineOnline(m, probe, input.agentOnline), reachable: probe ? probe.reachable : null };
  });
  return { projects, machines };
}
