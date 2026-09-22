import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Machine, Project, ProjectInput } from './types';
import { forgetLocalMachine, localMachineIds, rememberLocalMachine } from './local-machines';

export type MachineStatus = 'checking' | 'online' | 'offline';

interface DataState {
  /** machines visible in this browser: local machines of other computers are left out */
  machines: Machine[];
  /** every project of the scope (machines a browser hides do not hide projects) */
  projects: Project[];
  /** local machines (someone's own computer) added from another browser; hidden until claimed */
  hiddenLocal: Machine[];
  /** marks a hidden local machine as this computer (remembered in this browser) */
  claimLocal: (id: string) => void;
  statuses: Record<string, MachineStatus>;
  /** máquinas online sem tmux instalado */
  missingTmux: Record<string, boolean>;
  loading: boolean;
  refresh: () => Promise<void>;
  checkStatus: (machineId: string) => Promise<void>;
  createMachine: (input: Partial<Machine>) => Promise<Machine>;
  updateMachine: (id: string, input: Partial<Machine>) => Promise<Machine>;
  deleteMachine: (id: string) => Promise<void>;
  createProject: (input: ProjectInput) => Promise<Project>;
  updateProject: (id: string, input: ProjectInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  /** atualiza o contador de tasks abertas do projeto (sidebar) */
  setOpenTasks: (projectId: string, n: number) => void;
  linkMachine: (projectId: string, input: { machine_id: string; cwd: string; create_dir?: boolean }) => Promise<void>;
  updateProjectMachine: (projectId: string, machineId: string, cwd: string, createDir: boolean) => Promise<void>;
  /** removes the link; resolves with how many tabs were closed */
  unlinkMachine: (projectId: string, machineId: string) => Promise<number>;
  /** the visible Machine records a project is linked to, in link order */
  machinesOf: (project: Project) => Machine[];
}

const DataContext = createContext<DataState | null>(null);

const STATUS_INTERVAL_MS = 30_000;

export function DataProvider({ children }: { children: ReactNode }) {
  const [allMachines, setMachines] = useState<Machine[]>([]);
  const [allProjects, setProjects] = useState<Project[]>([]);
  const [localIds, setLocalIds] = useState(() => localMachineIds());
  const { machines, projects, hiddenLocal } = useMemo(() => {
    const visible = allMachines.filter((m) => !m.is_local || localIds.has(m.id));
    return {
      machines: visible,
      projects: allProjects,
      hiddenLocal: allMachines.filter((m) => m.is_local && !localIds.has(m.id)),
    };
  }, [allMachines, allProjects, localIds]);
  const claimLocal = useCallback((id: string) => {
    rememberLocalMachine(id);
    setLocalIds(localMachineIds());
  }, []);
  const [statuses, setStatuses] = useState<Record<string, MachineStatus>>({});
  const [missingTmux, setMissingTmux] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const machinesRef = useRef(machines);
  machinesRef.current = machines;

  const checkStatus = useCallback(async (machineId: string) => {
    setStatuses((s) => (s[machineId] ? s : { ...s, [machineId]: 'checking' }));
    try {
      const r = await api.machines.status(machineId);
      setStatuses((s) => ({ ...s, [machineId]: r.online ? 'online' : 'offline' }));
      setMissingTmux((m) => ({ ...m, [machineId]: r.online && !r.tmux }));
      setMachines((ms) =>
        ms.map((x) => {
          if (x.id !== machineId) return x;
          const next = r.online ? { ...x, os: r.os, capabilities: r.capabilities } : x;
          return {
            ...next,
            agent_version: r.agent_version !== undefined ? r.agent_version : next.agent_version,
            agent_last_seen_at: r.last_seen_at !== undefined ? r.last_seen_at : next.agent_last_seen_at,
            update_available: r.online ? (r.update_available ?? next.update_available) : false,
          };
        }),
      );
    } catch {
      setStatuses((s) => ({ ...s, [machineId]: 'offline' }));
    }
  }, []);

  // Estável (não depende de state): usado em effects dos componentes sem causar re-render em cascata.
  const setOpenTasks = useCallback((projectId: string, n: number) => {
    setProjects((p) => {
      const idx = p.findIndex((x) => x.id === projectId);
      if (idx === -1 || p[idx].open_tasks === n) return p; // nada mudou: mantém a referência
      const next = p.slice();
      next[idx] = { ...p[idx], open_tasks: n };
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const [m, p] = await Promise.all([api.machines.list(), api.projects.list()]);
    setMachines(m.machines);
    setProjects(p.projects);
    setLoading(false);
    const mine = localMachineIds();
    void Promise.all(m.machines.filter((x) => !x.is_local || mine.has(x.id)).map((x) => checkStatus(x.id)));
  }, [checkStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => {
      for (const m of machinesRef.current) void checkStatus(m.id);
    }, STATUS_INTERVAL_MS);
    return () => clearInterval(t);
  }, [checkStatus]);

  const value = useMemo<DataState>(
    () => ({
      machines,
      projects,
      hiddenLocal,
      claimLocal,
      statuses,
      missingTmux,
      loading,
      refresh,
      checkStatus,
      async createMachine(input) {
        const { machine } = await api.machines.create(input);
        if (machine.is_local) claimLocal(machine.id);
        setMachines((m) => [...m, machine]);
        void checkStatus(machine.id);
        return machine;
      },
      async updateMachine(id, input) {
        const { machine } = await api.machines.update(id, input);
        // the browser that (un)marks a machine as its own computer is the one that sees it
        if (machine.is_local) claimLocal(machine.id);
        else forgetLocalMachine(machine.id);
        setMachines((m) => m.map((x) => (x.id === id ? machine : x)));
        void checkStatus(machine.id);
        return machine;
      },
      async deleteMachine(id) {
        await api.machines.remove(id);
        forgetLocalMachine(id);
        setMachines((m) => m.filter((x) => x.id !== id));
      },
      async createProject(input) {
        const { project } = await api.projects.create(input);
        setProjects((p) => [...p, project].sort((a, b) => a.name.localeCompare(b.name)));
        return project;
      },
      async updateProject(id, input) {
        const { project } = await api.projects.update(id, input);
        setProjects((p) => p.map((x) => (x.id === id ? { ...project, open_tasks: x.open_tasks } : x)).sort((a, b) => a.name.localeCompare(b.name)));
        return project;
      },
      async deleteProject(id) {
        await api.projects.remove(id);
        setProjects((p) => p.filter((x) => x.id !== id));
      },
      setOpenTasks,
      async linkMachine(projectId, input) {
        const { link } = await api.projects.linkMachine(projectId, input);
        setProjects((p) => p.map((x) => (x.id === projectId ? { ...x, machines: [...x.machines, link] } : x)));
      },
      async updateProjectMachine(projectId, machineId, cwd, createDir) {
        const { link } = await api.projects.updateMachine(projectId, machineId, { cwd, create_dir: createDir });
        setProjects((p) => p.map((x) => (x.id === projectId ? { ...x, machines: x.machines.map((l) => (l.machine_id === machineId ? link : l)) } : x)));
      },
      async unlinkMachine(projectId, machineId) {
        const { closed_tabs } = await api.projects.unlinkMachine(projectId, machineId);
        setProjects((p) => p.map((x) => (x.id === projectId ? { ...x, machines: x.machines.filter((l) => l.machine_id !== machineId) } : x)));
        return closed_tabs;
      },
      machinesOf(project) {
        return project.machines.map((l) => machines.find((m) => m.id === l.machine_id)).filter((m): m is Machine => !!m);
      },
    }),
    [machines, projects, hiddenLocal, claimLocal, statuses, missingTmux, loading, refresh, checkStatus, setOpenTasks],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData fora do DataProvider');
  return ctx;
}
