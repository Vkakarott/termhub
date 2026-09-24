import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStateStorage } from '@/services/storage';

export type ThemePreference = 'system' | 'light' | 'dark';

interface ThemeState {
  theme: ThemePreference;
  setTheme(theme: ThemePreference): void;
}

export const useThemeStore = create<ThemeState>()(
  persist((set) => ({ theme: 'system', setTheme: (theme) => set({ theme }) }), {
    name: 'theme',
    storage: createJSONStorage(() => mmkvStateStorage),
  }),
);
