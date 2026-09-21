import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useChatStream } from '../lib/chat';
import type { ChatAction, ChatEvent, ChatMessage } from '../lib/types';

/** How a decided action reads once there is nothing left to click. `pending` has its own buttons
 * instead of a label here. */
const ACTION_STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: 'Autorizado',
  denied: 'Recusado',
  expired: 'Expirou sem resposta',
  executed: 'Executado',
  failed: 'Falhou',
};

/** The concierge chat: one conversation per user, streamed live over /ws/chat and persisted over REST. */
export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /**
   * The gate's action trail. Always sourced from `GET /api/chat` on load/reconnect — never rebuilt
   * from live events alone, which is what made it vanish on a reload before this task. A `confirmation`
   * event adds a card without waiting for a refetch; a `decision` event (possibly from another tab)
   * updates one by its id. Every row is keyed by its own `id`: a denial that lapsed leaves the old
   * decided row sitting beside a newer pending one for the very same proposal, so this must never
   * assume one row per proposal or per tool.
   */
  const [actions, setActions] = useState<ChatAction[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** A `queued: true` decision is not an error: the pt-BR note the server sent, shown under that card
   * until the next reload replaces it with the real, applied state. */
  const [queuedNotes, setQueuedNotes] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { messages, actions } = await api.chat();
    setMessages(messages);
    setActions(actions ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A `message` event means the answer was persisted: re-read it over REST to get the final
  // text. Delivered once per event by the hook, regardless of its own capped buffer, so this
  // never depends on — or breaks against — that buffer's length.
  const onEvent = useCallback(
    (e: ChatEvent) => {
      if (e.type === 'message') void load();
      else if (e.type === 'confirmation') {
        // Enriched server-side exactly like GET /api/chat's trail (same summary, same ids): no name
        // is resolved and no sentence is built here.
        setActions((prev) =>
          prev.some((a) => a.id === e.action_id)
            ? prev
            : [...prev, { id: e.action_id, tool: e.tool, args: e.args, class: e.class, status: 'pending', machine_id: e.machine_id, project_id: e.project_id, tab_id: e.tab_id, summary: e.summary, created_at: e.created_at }],
        );
      } else if (e.type === 'decision') {
        // Someone answered — possibly in another open tab. Keyed on the action id alone.
        setActions((prev) => prev.map((a) => (a.id === e.action_id ? { ...a, status: e.status } : a)));
      }
    },
    [load],
  );
  const { events, connected } = useChatStream(load, onEvent);

  const decide = async (id: string, decision: 'approve' | 'deny') => {
    setDecidingId(id);
    setActionError(null);
    try {
      const res = await api.decideChatAction(id, decision);
      // The response's `action` is the raw decided row, not the enriched card (no `summary`): only
      // its status is applied, keeping the card's already-known summary and other fields as they are.
      setActions((prev) => prev.map((a) => (a.id === id ? { ...a, status: res.action.status } : a)));
      if (res.queued && res.note) setQueuedNotes((prev) => ({ ...prev, [id]: res.note! }));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Não foi possível registrar a decisão');
    } finally {
      setDecidingId(null);
    }
  };

  /**
   * Deltas and the action trail of the answer being written, keyed by message id. A `reset`
   * event — the server retrying the run on a fresh CLI session — drops whatever streamed for
   * that message so far, so the abandoned half-answer never shows glued to the real one.
   */
  const live = useMemo(() => {
    const deltas = new Map<string, string>();
    const actions = new Map<string, { tool: string }[]>();
    /**
     * Assistant rows this page has seen any sign of life from: the `message` event that announces a
     * run, but also its deltas and its tool calls — a page opened (or reloaded, or a second tab)
     * after the run began never sees the announcement, and a tool-only phase can run for tens of
     * seconds with nothing else to show. An empty bubble only deserves a "pensando…" while its run
     * can still be alive; a row left empty by a process death — which happens on every deploy — is
     * never mentioned here at all, so it reads as the failure it is instead of waiting for ever.
     */
    const started = new Set<string>();
    for (const e of events) {
      if (e.type === 'delta') {
        deltas.set(e.message_id, (deltas.get(e.message_id) ?? '') + e.delta);
        started.add(e.message_id);
      } else if (e.type === 'action') {
        actions.set(e.message_id, [...(actions.get(e.message_id) ?? []), { tool: e.tool }]);
        started.add(e.message_id);
      } else if (e.type === 'reset') {
        deltas.delete(e.message_id);
        actions.delete(e.message_id);
      } else if (e.type === 'message' && e.message.role === 'assistant' && !e.message.text && !e.message.error_code) started.add(e.message.id);
    }
    return { deltas, actions, started };
  }, [events]);

  const listRef = useRef<HTMLOListElement>(null);
  // Keep the newest content in view: past one viewport the user would send a message and see
  // nothing move. Runs on every new message and on every streamed delta.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, events]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    // Cleared before the request, not after: the POST only resolves when the whole answer is
    // written, which can take a minute, and a box that keeps the sent text that long reads as a
    // chat that swallowed the message. On failure the text comes back below.
    setText('');
    try {
      await api.sendChatMessage(value);
      await load();
    } catch (e) {
      // a 409 CHAT_BUSY or a 503 CONCIERGE_DISABLED carries its own pt-BR message, shown as-is;
      // anything else falls back to a generic line
      setError(e instanceof ApiError ? e.message : 'Não foi possível enviar a mensagem');
      // Give the text back so nothing is lost — unless something new was typed meanwhile.
      setText((current) => current || value);
      // The server may have dropped the empty assistant row it had already announced (a run that
      // never started at all), so re-read instead of keeping a bubble that will never fill.
      await load();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Chat</h1>
        {!connected && <span className="text-xs text-warn">Reconectando…</span>}
      </div>
      <ol ref={listRef} className="flex-1 space-y-3 overflow-y-auto">
        {messages.map((m, index) => {
          const streaming = live.deltas.get(m.id);
          // An assistant row with no text and no error is either the answer being written right now
          // or a leftover from a run that died with the process. Only the newest row can still be
          // the live one, and only while this page knows its run is under way.
          const empty = m.role === 'assistant' && !m.text && !streaming && !m.error_code;
          const waiting = empty && index === messages.length - 1 && (sending || live.started.has(m.id));
          const body = m.text || streaming || (waiting ? 'pensando…' : '');
          return (
            <li key={m.id} className={`max-w-2xl rounded-lg border border-line px-3 py-2 text-sm ${m.role === 'user' ? 'ml-auto bg-accent/10' : 'bg-bg-2'}`}>
              <p className="whitespace-pre-wrap">{body}</p>
              {(live.actions.get(m.id) ?? []).map((a, i) => (
                <span key={i} className="mr-1 mt-1 inline-block rounded bg-bg-4 px-1.5 py-0.5 text-[10px] text-fg-dim">
                  {a.tool}
                </span>
              ))}
              {(m.error_code || (empty && !waiting)) && <p className="mt-1 text-xs text-danger">A resposta não terminou — tente de novo.</p>}
            </li>
          );
        })}
      </ol>
      {actions.length > 0 && (
        <ul className="mt-3 space-y-2">
          {actions.map((a) => (
            <li key={a.id} className="rounded-lg border border-line bg-bg-2 px-3 py-2 text-sm">
              {/* Plain text only — never HTML: this sentence can carry a command the model read off a real terminal screen. */}
              <p className="whitespace-pre-wrap">{a.summary}</p>
              {a.status === 'pending' ? (
                <div className="mt-1 flex gap-2">
                  <button type="button" className="btn-primary" disabled={decidingId === a.id} onClick={() => void decide(a.id, 'approve')}>
                    Autorizar
                  </button>
                  <button type="button" className="btn-danger" disabled={decidingId === a.id} onClick={() => void decide(a.id, 'deny')}>
                    Recusar
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-fg-dim">{ACTION_STATUS_LABEL[a.status]}</p>
              )}
              {queuedNotes[a.id] && <p className="mt-1 text-xs text-fg-dim">{queuedNotes[a.id]}</p>}
            </li>
          ))}
        </ul>
      )}
      {actionError && <p className="mt-2 text-sm text-danger">{actionError}</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 flex items-end gap-2">
        <textarea
          className="flex-1 resize-none rounded-lg border border-line bg-bg-2 px-3 py-2 text-sm"
          rows={2}
          value={text}
          placeholder="Pergunte ou peça algo às suas máquinas"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="btn-primary" onClick={() => void send()} disabled={sending}>
          Enviar
        </button>
      </div>
    </div>
  );
}
