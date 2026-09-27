// The app's one progress store, over the real API singleton and the session store.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createProgressStore } from './createProgressStore';

export const useProgressStore = createProgressStore({ api, session: () => useSessionStore.getState() });
