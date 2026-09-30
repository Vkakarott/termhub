// The project AI screen's services: the real API singleton and the session store (a screen test mocks this module).
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { api } from '@/services/api';
import type { ProjectAiDeps } from './use-project-ai';

export const projectAiDeps: ProjectAiDeps = { api, session: () => useSessionStore.getState() };
