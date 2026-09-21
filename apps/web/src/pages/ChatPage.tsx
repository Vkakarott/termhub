import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatActionCard } from '../components/chat/ChatActionCard';
import { ChatComposer } from '../components/chat/ChatComposer';
import { ChatTurn } from '../components/chat/ChatTurn';
import { api, ApiError } from '../lib/api';
import { useChatStream } from '../lib/chat';
import { chatTimeline } from '../lib/chat-timeline';
import { isNearBottom } from '../lib/chat-scroll';
import type { ChatAction, ChatEvent, ChatMessage } from '../lib/types';

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

  /**
   * Whether `GET /api/chat` has ever answered. Only the empty state reads it: without it, opening a
   * long conversation shows "peça algo…" over an empty thread until the fetch resolves, and a fetch
   * that fails leaves that line on screen for ever.
   */
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { messages, actions } = await api.chat();
    setMessages(messages);
    setActions(actions ?? []);
    setLoaded(true);
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

  /** Messages and gate cards as one chronological thread, so a card reads where it was proposed. */
  const timeline = useMemo(() => chatTimeline(messages, actions), [messages, actions]);
  /**
   * The row a running answer would be written into: only the newest one can still be the live one.
   * Keyed on the id, not on a position: the loop below walks the merged timeline, where an index
   * counts cards too and so no longer means "the newest message" — turning this back into
   * `index === messages.length - 1` would put "pensando…" on the wrong row.
   */
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;

  const listRef = useRef<HTMLOListElement>(null);
  /**
   * Whether the thread should keep following new content. Starts `true` (a page just opened is at
   * its own bottom) and is written only from the list's `onScroll` handler below and from `send`
   * — never recomputed from the list's live geometry inside the effect that follows it: jsdom lays
   * nothing out, so a never-scrolled list would read as "far from the bottom" and this would stop
   * following new messages in every test, and in any real browser the moment the content is
   * shorter than the viewport.
   */
  const stick = useRef(true);
  // Keep the newest content in view, but only while the reader hasn't scrolled away to read back
  // through history: past one viewport they would otherwise send a message, or watch an answer
  // stream in, and see the page yank itself out from under them. Runs on every new message and on
  // every streamed delta.
  // Keyed on the timeline, not on `messages`: a card is a row of this thread too, so a change to
  // `actions` alone — a `decide()` response, a queued note — must be able to move the scroll.
  useEffect(() => {
    const list = listRef.current;
    if (list && stick.current) list.scrollTop = list.scrollHeight;
  }, [timeline, events]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    // Sending is the reader's own way of saying "take me to the bottom" — the answer will stream
    // in below whatever they typed.
    stick.current = true;
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
    // Height and overflow belong to ChatLayout; this page owns the reading column: centred, capped
    // at a comfortable measure and padded so a long answer survives a phone. The bottom safe area
    // is the composer's own (`ChatComposer`), since it — not this column — is anchored to the edge.
    // `min-w-0` on this column and on the thread below is what keeps a phone honest: a flex item's
    // automatic minimum size is its min-content width, and `break-words` does not reduce that (by
    // spec, `overflow-wrap` never shrinks min-content). So one unbreakable token in an answer — a
    // `waiting_permission` in backticks, a long path — widened this column past the viewport and
    // took the composer's send button off screen with it.
    <div className="mx-auto flex h-full w-full min-w-0 max-w-3xl flex-col px-4">
      {!connected && <p className="pt-2 text-xs text-warn">Reconectando…</p>}
      {/* A new conversation is otherwise a header, an empty thread and a box: one line saying what
       * this screen is for. Deliberately just the one — no example prompts, no tour. */}
      {loaded && messages.length === 0 && <p className="pt-6 text-center text-sm text-fg-dim">Peça algo às suas máquinas: o concierge lê os terminais e pede sua autorização antes de qualquer alteração.</p>}
      {/* Named, because a rendered answer can contain Markdown lists of its own: this is how the
       * thread is told apart from them — by screen readers, and by the tests. */}
      <ol
        ref={listRef}
        aria-label="Conversa"
        className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain py-4"
        onScroll={(e) => {
          stick.current = isNearBottom(e.currentTarget);
        }}
      >
        {timeline.map((entry) => {
          if (entry.kind === 'action')
            return <ChatActionCard key={entry.action.id} action={entry.action} deciding={decidingId === entry.action.id} note={queuedNotes[entry.action.id]} onDecide={(decision) => void decide(entry.action.id, decision)} />;
          const m = entry.message;
          const streaming = live.deltas.get(m.id);
          // An assistant row with no text and no error is either the answer being written right now
          // or a leftover from a run that died with the process. Only the newest row can still be
          // the live one, and only while this page knows its run is under way.
          const empty = m.role === 'assistant' && !m.text && !streaming && !m.error_code;
          const waiting = empty && m.id === lastMessageId && (sending || live.started.has(m.id));
          return <ChatTurn key={m.id} message={m} streaming={streaming} tools={live.actions.get(m.id)} waiting={waiting} failed={Boolean(m.error_code) || (empty && !waiting)} />;
        })}
      </ol>
      {actionError && <p className="mb-2 text-sm text-danger">{actionError}</p>}
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      <ChatComposer value={text} onChange={setText} onSend={() => void send()} sending={sending} />
    </div>
  );
}
