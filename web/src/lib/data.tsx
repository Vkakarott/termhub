import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Machine, Project } from './types';

export type MachineStatus = 'checking' | 'online' | 'offline';

interface DataState {
  machines: Machine[];
  projects: Project[];
  statuses: Record<string, MachineStatus>;
  /** máquinas online sem tmux instalado */
  missingTmux: Record<string, boolean>;
  loading: boolean;
  refresh: () => Promise<void>;
  checkStatus: (machineId: string) => Promise<void>;
  createMachine: (input: Partial<Machine>) => Promise<Machine>;
  updateMachine: (id: string, input: Partial<Machine>) => Promise<Machine>;
  deleteMachine: (id: string) => Promise<void>;
  createProject: (input: Partial<Project>) => Promise<Project>;
  updateProject: (id: string, input: Partial<Project>) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  /** atualiza o contador de tasks abertas do projeto (sidebar) */
  setOpenTasks: (projectId: string, n: number) => void;
}

const DataContext = createContext<DataState | null>(null);

const STATUS_INTERVAL_MS = 30_000;

export function DataProvider({ children }: { children: ReactNode }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
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
    void Promise.all(m.machines.map((x) => checkStatus(x.id)));
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
      statuses,
      missingTmux,
      loading,
      refresh,
      checkStatus,
      async createMachine(input) {
        const { machine } = await api.machines.create(input);
        setMachines((m) => [...m, machine]);
        void checkStatus(machine.id);
        return machine;
      },
      async updateMachine(id, input) {
        const { machine } = await api.machines.update(id, input);
        setMachines((m) => m.map((x) => (x.id === id ? machine : x)));
        void checkStatus(machine.id);
        return machine;
      },
      async deleteMachine(id) {
        await api.machines.remove(id);
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
    }),
    [machines, projects, statuses, missingTmux, loading, refresh, checkStatus, setOpenTasks],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData fora do DataProvider');
  return ctx;
}
