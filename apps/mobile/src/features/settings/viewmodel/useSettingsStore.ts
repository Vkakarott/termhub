// The app's one settings store: the factory over the real API singleton and the session store.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createSettingsStore } from './createSettingsStore';

export const useSettingsStore = createSettingsStore({ api, session: () => useSessionStore.getState() });
