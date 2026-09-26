// The app's one "Memória do chat" store: the factory over the real API singleton and the session
// store, same pattern as `useChatStore.ts` / `useNotificationsStore.ts`.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createChatMemoryStore } from './createChatMemoryStore';

export const useChatMemoryStore = createChatMemoryStore({ api, session: () => useSessionStore.getState() });
