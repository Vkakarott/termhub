import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { useChatStream } from './chat';
import type { ChatEvent, ProjectChatStatus } from './types';

interface ProjectChatValue {
  /** The project whose chat the drawer shows, or null when it is closed. */
  openProjectId: string | null;
  /** The sidebar's 💬: opens that project's chat, swaps to it from another one, or closes it if open. */
  toggle(id: string): void;
  close(): void;
  /** Whether that project's chat is answering, and how many questions wait on the user. */
  status(id: string): { busy: boolean; pending: number };
}

const IDLE = { busy: false, pending: 0 };
/** Without a provider (a component rendered on its own, in a test) the chat is closed and idle. */
const ProjectChatContext = createContext<ProjectChatValue>({ openProjectId: null, toggle: () => {}, close: () => {}, status: () => IDLE });

export function ProjectChatProvider({ children }: { children: ReactNode }) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, ProjectChatStatus>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const { projects } = await api.chatProjects();
      setStatuses(new Map(projects.map((p) => [p.project_id, p])));
    } catch {
      /* an indicator, never an error: the next event tries again */
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  // A run starts and ends with a `message` event; a question appears with `confirmation` and goes
  // away with `decision`. Those are the only moments a dot can change, so they are the only re-reads.
  const onEvent = useCallback((e: ChatEvent) => {
    if (e.type === 'message' || e.type === 'confirmation' || e.type === 'decision') void refresh();
  }, [refresh]);
  useChatStream(refresh, onEvent);

  const value = useMemo<ProjectChatValue>(
    () => ({
      openProjectId,
      toggle: (id) => setOpenProjectId((cur) => (cur === id ? null : id)),
      close: () => setOpenProjectId(null),
      status: (id) => {
        const s = statuses.get(id);
        return s ? { busy: s.busy, pending: s.pending_confirmations } : IDLE;
      },
    }),
    [openProjectId, statuses],
  );
  return <ProjectChatContext.Provider value={value}>{children}</ProjectChatContext.Provider>;
}

export const useProjectChat = (): ProjectChatValue => useContext(ProjectChatContext);
