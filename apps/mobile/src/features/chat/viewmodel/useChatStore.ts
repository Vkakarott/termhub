// The app's one chat store: the factory over the real API singleton and the session store.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createChatStore } from './createChatStore';

export const useChatStore = createChatStore({ api, session: () => useSessionStore.getState() });
