// "Memória do chat" (chat decision memory spec 2026-09-26 §5.2): the mobile twin of the web's
// `ChatMemoryPage` — the suggestion switch and the searchable, paginated list of remembered
// decisions. A factory over injected services, same shape as the other feature stores, so tests
// drive it against the mock transport; `useChatMemoryStore.ts` builds the app's one instance.
//
// Search and "Carregar mais" share one request-generation counter (`gen`, module-private to this
// factory): every fresh first page — the initial `load()` and every debounced `search()` — bumps
// it, and a page (first or "more") that resolves after a newer one started is dropped, so a slow,
// superseded search can never overwrite what a faster, later one already showed. This mirrors
// `ChatMemoryPage`'s `genRef`.
//
// `toggle()`/`forget()` deliberately do NOT share that counter: sharing it would let an unrelated
// search finishing first make the switch fall back to its pre-toggle value, or bring back a row
// just forgotten. They apply their own result unconditionally instead — this mirrors
// `ChatMemoryPage`'s `mountedRef` being kept apart from `genRef`. A first page, in turn, counts
// completed toggles (`toggles`) when it starts and drops its `memory` if one completed meanwhile:
// that read may predate the PATCH and would flip the switch back (its list still applies) — the
// same rule as `ChatMemoryPage`'s `togglesRef`.
//
// Unlike a component, this store is never itself "unmounted" — it is a singleton that outlives the
// screen — but the *screen* still needs a way to say "I am gone, drop whatever you were about to
// show me": `cancel()` clears a still-pending debounce timer and bumps `gen`, so neither a search
// typed right before leaving nor one already in flight can land later and clobber the next visit's
// fresh `load()`. The screen calls it from its unmount cleanup; `toggle()`/`forget()` are untouched
// by it on purpose (see above) — the store is still alive to receive their result, and the next
// visit re-reads everything from scratch anyway.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import type { TChatDecision, TChatMemory } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';

/** What this store needs from the session store: `auth()` for every call, `handleApiError` for a
 * session-ending answer — the same small contract the notifications store's `SessionApi` uses. */
export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface ChatMemoryDeps {
  api: MobileApi;
  session: () => SessionApi;
  /** The delay before `search` re-queries; defaults to 300ms (design spec §5.2, same as the web).
   * Overridable so a test does not need to drive real timers. */
  debounceMs?: number;
}

export interface ChatMemoryState {
  memory: TChatMemory | null;
  decisions: TChatDecision[] | null;
  cursor: string | null;
  q: string;
  loadingMore: boolean;
  switching: boolean;
  /** The decision whose "Esquecer" is in flight. */
  forgettingId: string | null;
  error: string | null;

  /** The first read: both the switch/count and the (possibly already filtered, by `q`) list, at
   * once — call once when the screen mounts. */
  load(): Promise<void>;
  /** Updates the search text right away and re-queries after the debounce (`ChatMemoryPage`'s own
   * delay); the store's own `load()` is the only read that ever runs without waiting for it. */
  search(q: string): void;
  /** The next page, appended; a no-op with no `cursor` or while one is already loading. */
  loadMore(): Promise<void>;
  /** Flips the suggestion switch. */
  toggle(): Promise<void>;
  /** "Esquecer": the same hard delete as a card's "Esquecer esta decisão". */
  forget(id: string): Promise<void>;
  /** Cancels a pending debounce timer and drops any first-page/"more" response still in flight,
   * without touching what is currently shown. Call this from the screen's unmount — see the note
   * above `toggle()`/`forget()` for why they are not affected. */
  cancel(): void;
}

type Data = Omit<ChatMemoryState, { [K in keyof ChatMemoryState]: ChatMemoryState[K] extends (...args: never[]) => unknown ? K : never }[keyof ChatMemoryState]>;

const initialData = (): Data => ({ memory: null, decisions: null, cursor: null, q: '', loadingMore: false, switching: false, forgettingId: null, error: null });

const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export function createChatMemoryStore(deps: ChatMemoryDeps) {
  const { api, session } = deps;
  const debounceMs = deps.debounceMs ?? 300;

  let gen = 0;
  let toggles = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Clears a pending debounce timer and bumps `gen`, so a first-page/"more" response already in
   * flight is dropped by its own `gen !== myGen` check once it resolves. Shared by `cancel()` and
   * the `sessionEnded` reset below. */
  const cancelPending = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    gen++;
  };

  const store = create<ChatMemoryState>()((set, get) => {
    const runFirstPage = async (query: string): Promise<void> => {
      const myGen = ++gen;
      const myToggles = toggles;
      set({ error: null });
      try {
        const [memory, page] = await Promise.all([api.chatMemory(session().auth()), api.chatDecisions(session().auth(), query || undefined)]);
        if (gen !== myGen) return; // superseded by a newer search
        // A toggle that completed meanwhile holds the newer switch value; keep it.
        set(toggles === myToggles ? { memory, decisions: page.decisions, cursor: page.next_cursor } : { decisions: page.decisions, cursor: page.next_cursor });
      } catch (e) {
        if (gen !== myGen) return;
        if (session().handleApiError(e)) return;
        set({ error: isApiError(e) ? e.message : 'Não foi possível carregar a memória do chat' });
      }
    };

    return {
      ...initialData(),

      load() {
        return runFirstPage(get().q);
      },

      search(q) {
        set({ q });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void runFirstPage(q);
        }, debounceMs);
      },

      async loadMore() {
        const cursor = get().cursor;
        if (!cursor || get().loadingMore) return;
        const myGen = gen; // not bumped: "more" of the search that is current when it starts
        set({ loadingMore: true, error: null });
        try {
          const page = await api.chatDecisions(session().auth(), get().q || undefined, cursor);
          if (gen !== myGen) return; // a newer search started (or finished) meanwhile
          set((s) => ({ decisions: [...(s.decisions ?? []), ...page.decisions], cursor: page.next_cursor, loadingMore: false }));
        } catch (e) {
          if (gen !== myGen) return;
          set({ loadingMore: false });
          if (session().handleApiError(e)) return;
          set({ error: isApiError(e) ? e.message : 'Não foi possível carregar mais decisões' });
        }
      },

      async toggle() {
        const memory = get().memory;
        if (!memory || get().switching) return;
        set({ switching: true, error: null });
        try {
          const next = await api.setChatMemory(session().auth(), !memory.enabled);
          toggles++;
          set({ memory: next, switching: false });
        } catch (e) {
          set({ switching: false });
          if (session().handleApiError(e)) return;
          set({ error: isApiError(e) ? e.message : 'Não foi possível alterar a sugestão de respostas' });
        }
      },

      async forget(id) {
        if (get().forgettingId !== null) return;
        set({ forgettingId: id, error: null });
        try {
          await api.forgetChatDecision(session().auth(), id);
          set((s) => ({ decisions: (s.decisions ?? []).filter((d) => d.id !== id), forgettingId: null }));
        } catch (e) {
          set({ forgettingId: null });
          if (session().handleApiError(e)) return;
          set({ error: isApiError(e) ? e.message : 'Não foi possível esquecer a decisão' });
        }
      },

      cancel() {
        cancelPending();
      },
    };
  });

  // Design spec §5.5: the end of a session resets every store that holds per-session data, so the
  // next enrolled device never sees the previous session's decisions.
  sessionEnded.subscribe(() => {
    cancelPending();
    store.setState(initialData());
  });

  return store;
}
