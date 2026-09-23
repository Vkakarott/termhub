import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { moveGroup } from './project-groups-model';
import type { ProjectGroup } from './types';

interface ProjectGroupsState {
  groups: ProjectGroup[];
  /** last failed write, pt-BR; cleared by the next successful one */
  error: string | null;
  reload(): Promise<void>;
  createGroup(name: string): Promise<ProjectGroup | null>;
  renameGroup(id: string, name: string): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  reorderGroups(groupId: string, toIndex: number): Promise<void>;
  setMemberships(next: ProjectGroup[], changes: { id: string; project_ids: string[] }[]): Promise<void>;
  isFavorite(projectId: string): boolean;
  toggleFavorite(projectId: string): Promise<void>;
}

const Ctx = createContext<ProjectGroupsState | null>(null);
const FAILED = 'Não foi possível salvar os grupos. Tente de novo.';

/** The signed-in user's sidebar groups. Writes show at once and roll back when the server refuses them. */
export function ProjectGroupsProvider({ children }: { children: ReactNode }) {
  const { viewAs } = useAuth();
  const [groups, setGroupsState] = useState<ProjectGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(groups);
  const setGroups = (g: ProjectGroup[]) => {
    ref.current = g;
    setGroupsState(g);
  };

  const reload = useCallback(async () => {
    try {
      setGroups((await api.projectGroups.list()).groups);
    } catch {
      /* sidebar still works without groups: everything shows in Outros */
    }
  }, []);
  // members are filtered by the current scope, so a view-as switch changes them. Compared by value
  // (not by reference): useAuth() may hand back a freshly built object every render even when the
  // scope itself did not change, and a reference-based dependency would reload (and clobber any
  // optimistic write in flight) on every unrelated re-render.
  const viewAsKey = JSON.stringify(viewAs);
  useEffect(() => { void reload(); }, [reload, viewAsKey]);

  /** Applies `next` now, runs the request, keeps the server's answer or restores the previous state. */
  const optimistic = useCallback(async (next: ProjectGroup[], send: () => Promise<ProjectGroup[] | null>) => {
    const prev = ref.current;
    setGroups(next);
    try {
      const fromServer = await send();
      if (fromServer) setGroups(fromServer);
      setError(null);
    } catch {
      setGroups(prev);
      setError(FAILED);
    }
  }, []);

  const value = useMemo<ProjectGroupsState>(() => {
    const favorites = () => ref.current.find((g) => g.kind === 'favorites');
    return {
      groups,
      error,
      reload,
      createGroup: async (name) => {
        try {
          const { group } = await api.projectGroups.create(name);
          setGroups([...ref.current, group]);
          setError(null);
          return group;
        } catch {
          setError(FAILED);
          return null;
        }
      },
      renameGroup: (id, name) =>
        optimistic(ref.current.map((g) => (g.id === id ? { ...g, name } : g)), async () => {
          const { group } = await api.projectGroups.rename(id, name);
          return ref.current.map((g) => (g.id === id ? group : g));
        }),
      deleteGroup: (id) =>
        optimistic(ref.current.filter((g) => g.id !== id), async () => {
          await api.projectGroups.remove(id);
          return null;
        }),
      reorderGroups: (groupId, toIndex) => {
        const next = moveGroup(ref.current, groupId, toIndex);
        return optimistic(next, async () => (await api.projectGroups.reorder(next.map((g) => g.id))).groups);
      },
      setMemberships: (next, changes) => optimistic(next, async () => (await api.projectGroups.setMemberships(changes)).groups),
      isFavorite: (projectId) => !!favorites()?.project_ids.includes(projectId),
      toggleFavorite: (projectId) => {
        const fav = favorites();
        if (!fav) return Promise.resolve();
        const project_ids = fav.project_ids.includes(projectId) ? fav.project_ids.filter((id) => id !== projectId) : [...fav.project_ids, projectId];
        const next = ref.current.map((g) => (g.id === fav.id ? { ...g, project_ids } : g));
        return optimistic(next, async () => (await api.projectGroups.setMemberships([{ id: fav.id, project_ids }])).groups);
      },
    };
  }, [groups, error, reload, optimistic]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjectGroups(): ProjectGroupsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useProjectGroups fora do ProjectGroupsProvider');
  return ctx;
}
