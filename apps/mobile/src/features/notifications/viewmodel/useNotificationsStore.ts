// The app's one notifications store: the factory over the real API singleton, the session store
// and the chat store's socket taps (`subscribeEvents`, `projects` for the live confirmation's
// body).
import { api } from '@/services/api';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createNotificationsStore } from './createNotificationsStore';

export const useNotificationsStore = createNotificationsStore({
  api,
  session: () => useSessionStore.getState(),
  events: { subscribe: (fn) => useChatStore.getState().subscribeEvents(fn) },
  projectName: (projectId) => (projectId ? (useChatStore.getState().projects.find((p) => p.id === projectId)?.name ?? null) : null),
});
