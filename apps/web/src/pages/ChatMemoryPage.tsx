import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ChatDecision, ChatMemory, ConciergeNote } from '../lib/types';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

/** One decision's answer, as the list shows it: the picked labels, or the free text (spec 2026-09-26
 * §4.6 — `answer.text` and `answer.labels` are mutually meaningful, never both at once). */
function answerText(d: ChatDecision): string {
  return d.answer.text ?? d.answer.labels.join(', ');
}

/**
 * "Memória do chat" (spec 2026-09-26 §5.2), at `/chat/memoria`: the switch, a search field and the
 * list of remembered decisions, paginated. Forgetting here is the same hard delete as "Esquecer esta
 * decisão" on a card — a card still pointing at a row removed here simply stops offering it.
 */
export function ChatMemoryPage() {
  const [memory, setMemory] = useState<ChatMemory | null>(null);
  const [decisions, setDecisions] = useState<ChatDecision[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [autodeciding, setAutodeciding] = useState(false);
  const [forgettingId, setForgettingId] = useState<string | null>(null);
  // "Anotações do concierge" (spec D12/§8): its own list, independent of the search box above (which
  // only ever filters decisions) — fetched once, not re-read on every keystroke of `q`.
  const [notes, setNotes] = useState<ConciergeNote[] | null>(null);
  const [notesCursor, setNotesCursor] = useState<string | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [loadingMoreNotes, setLoadingMoreNotes] = useState(false);
  const [forgettingNoteId, setForgettingNoteId] = useState<string | null>(null);

  /**
   * `genRef` guards against a slow, superseded search resolving after a newer one and overwriting its
   * results — the debounce below only ever cancels the *timer*, never a request already in flight.
   * Every "first page" load bumps it to a fresh value and only applies its result (`loadFirstPage`) or
   * appends its page (`loadMore`) if it is still the current one; unmounting also bumps it, so a load
   * still in flight at that point is dropped too.
   *
   * `toggle` and `forget` do *not* use `genRef`: a search starting (and even finishing) while their own
   * PATCH/DELETE is in flight must never make them drop their own successful result — that read the
   * switch back to its old value after a real toggle, or left a forgotten row still listed. They only
   * need to guard against the one hazard that is actually theirs: the page having unmounted by the time
   * they resolve. `mountedRef` is exactly that — true until the cleanup effect below turns it off.
   * Forgetting is safe to apply unconditionally otherwise: filtering a row out of whatever `decisions`
   * holds by then is a no-op if a newer search already replaced the list without that row in it.
   *
   * `togglesRef` counts completed toggles: a first-page load snapshots it when it starts and drops its
   * `mem` if a toggle completed meanwhile — that `GET /memory` may have been read before the PATCH
   * landed, and applying it would flip the switch back. Its list still applies.
   */
  const genRef = useRef(0);
  const togglesRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      genRef.current += 1;
      mountedRef.current = false;
    },
    [],
  );

  /** Re-reads both halves from the first page: the switch/count line and the (possibly filtered) list. */
  const loadFirstPage = useCallback(async (query: string) => {
    const myGen = ++genRef.current;
    const myToggles = togglesRef.current;
    setError(null);
    try {
      const [mem, page] = await Promise.all([api.chatMemory(), api.chatDecisions(query || undefined)]);
      if (genRef.current !== myGen) return; // superseded by a newer search, or unmounted meanwhile
      if (togglesRef.current === myToggles) setMemory(mem); // else a toggle's own result is newer
      setDecisions(page.decisions);
      setCursor(page.next_cursor);
    } catch (e) {
      if (genRef.current !== myGen) return;
      setError(e instanceof ApiError ? e.message : 'Não foi possível carregar a memória do chat');
    }
  }, []);

  // The first read runs at once; every change to `q` after that is debounced (~300ms) so typing does
  // not fire a request per keystroke.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      void loadFirstPage(q);
      return;
    }
    const t = setTimeout(() => void loadFirstPage(q), 300);
    return () => clearTimeout(t);
  }, [q, loadFirstPage]);

  const loadMore = async () => {
    if (!cursor) return;
    const myGen = genRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.chatDecisions(q || undefined, cursor);
      if (genRef.current !== myGen) return; // a newer search started, or unmounted, while this ran
      setDecisions((prev) => [...(prev ?? []), ...page.decisions]);
      setCursor(page.next_cursor);
    } catch (e) {
      if (genRef.current !== myGen) return;
      setError(e instanceof ApiError ? e.message : 'Não foi possível carregar mais decisões');
    } finally {
      if (genRef.current === myGen) setLoadingMore(false);
    }
  };

  const toggle = async () => {
    if (!memory) return;
    setSwitching(true);
    setError(null);
    try {
      const next = await api.setChatMemory(!memory.enabled);
      togglesRef.current += 1;
      if (!mountedRef.current) return;
      setMemory(next);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof ApiError ? e.message : 'Não foi possível alterar a sugestão de respostas');
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  };

  const forget = async (d: ChatDecision) => {
    if (!window.confirm(`Esquecer a decisão sobre «${d.question}»?`)) return;
    setForgettingId(d.id);
    setError(null);
    try {
      await api.forgetChatDecision(d.id);
      if (!mountedRef.current) return;
      setDecisions((prev) => (prev ?? []).filter((x) => x.id !== d.id));
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof ApiError ? e.message : 'Não foi possível esquecer a decisão');
    } finally {
      if (mountedRef.current) setForgettingId(null);
    }
  };

  /** "Responder sozinho quando houver precedente" (spec D8): shares the same `memory` row and `switching`
   *  guard model as `toggle` above, but its own busy flag — the two switches are independent controls. */
  const toggleAutodecide = async () => {
    if (!memory) return;
    setAutodeciding(true);
    setError(null);
    try {
      const next = await api.setChatMemory({ autodecide: !memory.autodecide });
      togglesRef.current += 1;
      if (!mountedRef.current) return;
      setMemory(next);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof ApiError ? e.message : 'Não foi possível alterar a resposta automática');
    } finally {
      if (mountedRef.current) setAutodeciding(false);
    }
  };

  useEffect(() => {
    api.chatNotes().then(
      (page) => {
        if (!mountedRef.current) return;
        setNotes(page.notes);
        setNotesCursor(page.next_cursor);
      },
      (e) => {
        if (!mountedRef.current) return;
        setNotesError(e instanceof ApiError ? e.message : 'Não foi possível carregar as anotações do concierge');
      },
    );
    // mountedRef alone guards this: no search or toggle ever races a note's own state.
  }, []);

  const loadMoreNotes = async () => {
    if (!notesCursor) return;
    setLoadingMoreNotes(true);
    setNotesError(null);
    try {
      const page = await api.chatNotes(notesCursor);
      if (!mountedRef.current) return;
      setNotes((prev) => [...(prev ?? []), ...page.notes]);
      setNotesCursor(page.next_cursor);
    } catch (e) {
      if (!mountedRef.current) return;
      setNotesError(e instanceof ApiError ? e.message : 'Não foi possível carregar mais anotações');
    } finally {
      if (mountedRef.current) setLoadingMoreNotes(false);
    }
  };

  const forgetNote = async (n: ConciergeNote) => {
    if (!window.confirm(`Esquecer a anotação sobre «${n.question}»?`)) return;
    setForgettingNoteId(n.id);
    setNotesError(null);
    try {
      await api.forgetChatNote(n.id);
      if (!mountedRef.current) return;
      setNotes((prev) => (prev ?? []).filter((x) => x.id !== n.id));
    } catch (e) {
      if (!mountedRef.current) return;
      setNotesError(e instanceof ApiError ? e.message : 'Não foi possível esquecer a anotação');
    } finally {
      if (mountedRef.current) setForgettingNoteId(null);
    }
  };

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl flex-1 overflow-y-auto px-4 py-6">
      <h2 className="text-lg font-semibold text-fg">Memória do chat</h2>
      <p className="mt-1 text-sm text-fg-muted">
        O que o concierge lembra das suas respostas anteriores, para sugerir a mesma resposta quando uma aba perguntar de novo.
      </p>

      {memory?.available === false ? (
        <p className="mt-4 text-sm text-fg-dim">Sugestões indisponíveis neste servidor</p>
      ) : (
        memory && (
          <>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 p-3">
              <span className="text-sm text-fg">Sugerir respostas com base nas minhas decisões</span>
              <button
                type="button"
                role="switch"
                aria-checked={memory.enabled}
                aria-label="Sugerir respostas com base nas minhas decisões"
                disabled={switching}
                onClick={() => void toggle()}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${memory.enabled ? 'bg-accent' : 'bg-fg-dim/40'}`}
              >
                <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${memory.enabled ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-fg-muted'}`} />
              </button>
            </div>
            <div className="mt-3 rounded-lg border border-line bg-bg-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-fg">Responder sozinho quando houver precedente</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={memory.autodecide}
                  aria-label="Responder sozinho quando houver precedente"
                  disabled={autodeciding}
                  onClick={() => void toggleAutodecide()}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${memory.autodecide ? 'bg-accent' : 'bg-fg-dim/40'}`}
                >
                  <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${memory.autodecide ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-fg-muted'}`} />
                </button>
              </div>
              <p className="mt-1 text-xs text-fg-dim">
                Quando a resposta repetir uma decisão sua recente, o concierge espera 60 segundos antes de responder por você, dando tempo de cancelar.
              </p>
            </div>
          </>
        )
      )}

      <div className="mt-4">
        <label className="label" htmlFor="chat-memory-search">
          Buscar
        </label>
        <input id="chat-memory-search" className="input mt-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="pergunta, resposta ou projeto" />
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {decisions === null ? (
        <p className="mt-4 text-sm text-fg-dim">Carregando…</p>
      ) : decisions.length === 0 ? (
        <p className="mt-4 text-sm text-fg-dim">Nenhuma decisão lembrada ainda.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {decisions.map((d) => (
            <li key={d.id} className="rounded-lg border border-line bg-bg-2 p-3 text-sm">
              <p className="whitespace-pre-wrap text-fg">{d.question}</p>
              <p className="mt-1 text-fg-muted">{`→ ${answerText(d)}`}</p>
              <p className="mt-1 text-xs text-fg-dim">
                {`${d.project_name ?? 'sem projeto'} · ${fmtDate(d.created_at)} · sugerida ${d.suggested_count}× · aceita ${d.accepted_count}×`}
              </p>
              <button type="button" className="btn-ghost mt-2 text-xs text-danger" disabled={forgettingId === d.id} onClick={() => void forget(d)}>
                Esquecer
              </button>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <button type="button" className="btn-ghost mt-4" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Carregando…' : 'Carregar mais'}
        </button>
      )}

      <h3 className="mt-8 text-base font-semibold text-fg">Anotações do concierge</h3>
      <p className="mt-1 text-sm text-fg-muted">Decisões que o concierge registrou por conta própria, com o motivo que deu para cada uma.</p>

      {notesError && <p className="mt-3 text-sm text-danger">{notesError}</p>}

      {notes === null ? (
        <p className="mt-4 text-sm text-fg-dim">Carregando…</p>
      ) : notes.length === 0 ? (
        <p className="mt-4 text-sm text-fg-dim">Nenhuma anotação ainda.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-line bg-bg-2 p-3 text-sm">
              <p className="whitespace-pre-wrap text-fg">{n.question}</p>
              <p className="mt-1 text-fg-muted">{`→ ${n.decision}`}</p>
              <p className="mt-1 text-xs text-fg-dim">{`${n.reason} · ${n.project_name ?? 'sem projeto'} · ${fmtDate(n.created_at)}`}</p>
              <button type="button" className="btn-ghost mt-2 text-xs text-danger" disabled={forgettingNoteId === n.id} onClick={() => void forgetNote(n)}>
                Esquecer
              </button>
            </li>
          ))}
        </ul>
      )}

      {notesCursor && (
        <button type="button" className="btn-ghost mt-4" disabled={loadingMoreNotes} onClick={() => void loadMoreNotes()}>
          {loadingMoreNotes ? 'Carregando…' : 'Carregar mais anotações'}
        </button>
      )}
    </div>
  );
}
