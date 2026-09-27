// The Progresso tab's store (spec 2026-09-26 progress-panel D10): the active epics across the
// user's projects, polled while the tab is focused. Same factory shape as the notifications store.
import { create } from 'zustand';
import type { TEpicProgress } from '@/services/api/contract';
import type { Auth, MobileApi } from '@/services/api/types';

export const PROGRESS_POLL_MS = 20_000;
const LOAD_FAILED = 'Não foi possível carregar o progresso.';

export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface ProgressState {
  epics: TEpicProgress[];
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  startPolling(): void;
  stopPolling(): void;
}

export function createProgressStore(deps: { api: MobileApi; session: () => SessionApi }) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const store = create<ProgressState>()((set, get) => ({
    epics: [],
    loading: false,
    error: null,
    async load() {
      set({ loading: true });
      try {
        const res = await deps.api.progress(deps.session().auth(), 'active');
        set({ epics: res.epics, loading: false, error: null });
      } catch (err) {
        if (deps.session().handleApiError(err)) {
          get().stopPolling();
          set({ loading: false });
          return;
        }
        set({ loading: false, error: LOAD_FAILED });
      }
    },
    startPolling() {
      get().stopPolling();
      void get().load();
      timer = setInterval(() => void get().load(), PROGRESS_POLL_MS);
    },
    stopPolling() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  }));
  return store;
}
