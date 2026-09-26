import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ChatDecision, ChatMemory } from '../lib/types';

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
  const [forgettingId, setForgettingId] = useState<string | null>(null);

  /**
   * Guards against two hazards that both come from state updates arriving after the request that
   * produced them stopped mattering: (1) a slow, superseded search resolving after a newer one and
   * overwriting its results — the debounce below only ever cancels the *timer*, never a request
   * already in flight; (2) any update landing after the page unmounted. Every "first page" load bumps
   * this to a fresh value and only applies its result if it is still the current one; unmounting bumps
   * it too, which invalidates every load (first page or "more") still in flight. `loadMore`, `toggle`
   * and `forget` each snapshot the value before their own request and re-check it after, so any of
   * them landing after a newer search started, or after unmount, is silently dropped.
   */
  const genRef = useRef(0);
  useEffect(() => () => {
    genRef.current += 1;
  }, []);

  /** Re-reads both halves from the first page: the switch/count line and the (possibly filtered) list. */
  const loadFirstPage = useCallback(async (query: string) => {
    const myGen = ++genRef.current;
    setError(null);
    try {
      const [mem, page] = await Promise.all([api.chatMemory(), api.chatDecisions(query || undefined)]);
      if (genRef.current !== myGen) return; // superseded by a newer search, or unmounted meanwhile
      setMemory(mem);
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
    const myGen = genRef.current;
    setSwitching(true);
    setError(null);
    try {
      const next = await api.setChatMemory(!memory.enabled);
      if (genRef.current !== myGen) return; // unmounted meanwhile
      setMemory(next);
    } catch (e) {
      if (genRef.current !== myGen) return;
      setError(e instanceof ApiError ? e.message : 'Não foi possível alterar a sugestão de respostas');
    } finally {
      if (genRef.current === myGen) setSwitching(false);
    }
  };

  const forget = async (d: ChatDecision) => {
    if (!window.confirm(`Esquecer a decisão sobre «${d.question}»?`)) return;
    const myGen = genRef.current;
    setForgettingId(d.id);
    setError(null);
    try {
      await api.forgetChatDecision(d.id);
      if (genRef.current !== myGen) return; // unmounted meanwhile
      setDecisions((prev) => (prev ?? []).filter((x) => x.id !== d.id));
    } catch (e) {
      if (genRef.current !== myGen) return;
      setError(e instanceof ApiError ? e.message : 'Não foi possível esquecer a decisão');
    } finally {
      if (genRef.current === myGen) setForgettingId(null);
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
    </div>
  );
}
