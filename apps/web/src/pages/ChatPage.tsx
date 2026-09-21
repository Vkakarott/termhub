import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useChatStream } from '../lib/chat';
import type { ChatEvent, ChatMessage } from '../lib/types';

/** The concierge chat: one conversation per user, streamed live over /ws/chat and persisted over REST. */
export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { messages } = await api.chat();
    setMessages(messages);
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
    },
    [load],
  );
  const { events, connected } = useChatStream(load, onEvent);

  /**
   * Deltas and the action trail of the answer being written, keyed by message id. A `reset`
   * event — the server retrying the run on a fresh CLI session — drops whatever streamed for
   * that message so far, so the abandoned half-answer never shows glued to the real one.
   */
  const live = useMemo(() => {
    const deltas = new Map<string, string>();
    const actions = new Map<string, { tool: string }[]>();
    for (const e of events) {
      if (e.type === 'delta') deltas.set(e.message_id, (deltas.get(e.message_id) ?? '') + e.delta);
      else if (e.type === 'action') actions.set(e.message_id, [...(actions.get(e.message_id) ?? []), { tool: e.tool }]);
      else if (e.type === 'reset') {
        deltas.delete(e.message_id);
        actions.delete(e.message_id);
      }
    }
    return { deltas, actions };
  }, [events]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendChatMessage(value);
      setText('');
      await load();
    } catch (e) {
      // a 409 CHAT_BUSY carries its own pt-BR message, shown as-is; anything else falls back to a generic line
      setError(e instanceof ApiError ? e.message : 'Não foi possível enviar a mensagem');
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
      <ol className="flex-1 space-y-3 overflow-y-auto">
        {messages.map((m) => {
          const streaming = live.deltas.get(m.id);
          const body = m.text || streaming || (m.role === 'assistant' ? 'pensando…' : '');
          return (
            <li key={m.id} className={`max-w-2xl rounded-lg border border-line px-3 py-2 text-sm ${m.role === 'user' ? 'ml-auto bg-accent/10' : 'bg-bg-2'}`}>
              <p className="whitespace-pre-wrap">{body}</p>
              {(live.actions.get(m.id) ?? []).map((a, i) => (
                <span key={i} className="mr-1 mt-1 inline-block rounded bg-bg-4 px-1.5 py-0.5 text-[10px] text-fg-dim">
                  {a.tool}
                </span>
              ))}
              {m.error_code && <p className="mt-1 text-xs text-danger">A resposta não terminou — tente de novo.</p>}
            </li>
          );
        })}
      </ol>
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
