import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMonitor } from '../lib/monitor';
import { ApiError } from '../lib/api';
import { NEEDS_YOU, TAB_STATE_LABEL, type MonitorItem, type TabState } from '../lib/types';

function since(iso: string | null, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `há ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  return `há ${Math.round(m / 60)} h`;
}

function stateStyle(state: TabState | null): string {
  switch (state) {
    case 'waiting_permission':
      return 'bg-warn/15 text-warn';
    case 'waiting_input':
      return 'bg-accent/15 text-accent';
    case 'idle':
      return 'bg-bg-4 text-fg-muted';
    case 'error':
      return 'bg-danger/15 text-danger';
    default:
      return 'bg-ok/15 text-ok';
  }
}

function Item({ item, now }: { item: MonitorItem; now: number }) {
  const { reply } = useMonitor();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tab, project, machine } = item;
  const waiting = !!tab.state && NEEDS_YOU.includes(tab.state);

  const send = async (e: FormEvent, value = text) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      await reply(tab.id, value);
      setText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar');
    } finally {
      setSending(false);
    }
  };

  return (
    <li className={`rounded-lg border bg-bg-2 p-3 ${waiting ? 'border-accent/50' : 'border-line'}`}>
      <div className="flex items-center gap-2 text-sm">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${stateStyle(tab.state)}`}>{tab.state ? TAB_STATE_LABEL[tab.state] : '—'}</span>
        <Link to={`/projects/${project.id}`} className="truncate font-medium hover:underline">
          {project.name}
        </Link>
        <span className="truncate text-fg-dim">
          › {tab.name}
          {tab.state_tool ? ` · ${tab.state_tool}` : ''}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-fg-dim">
          {machine.name} · {since(tab.state_at, now)}
        </span>
      </div>
      {tab.state_text && <p className="mt-2 whitespace-pre-wrap break-words rounded bg-bg-3 px-2 py-1.5 text-xs text-fg">{tab.state_text}</p>}
      {waiting && (
        <form className="mt-2 flex items-center gap-2" onSubmit={send}>
          <input
            className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
            placeholder={tab.state === 'waiting_permission' ? 'Resposta (ou só Enter para aceitar)…' : 'Responder no terminal…'}
            value={text}
            disabled={sending}
            onChange={(e) => setText(e.target.value)}
          />
          {tab.state === 'waiting_permission' && (
            <button type="button" className="rounded bg-bg-3 px-2 py-1 text-xs hover:bg-bg-4 disabled:opacity-50" disabled={sending} onClick={(e) => void send(e, 'y')}>
              y
            </button>
          )}
          <button type="submit" className="rounded bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50" disabled={sending}>
            {sending ? '…' : 'Enviar ⏎'}
          </button>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}

/** Home: tabs whose tool is waiting for the person first, then the ones that just finished. */
export function NeedsYouList({ now }: { now: number }) {
  const { items, needsYou, connected } = useMonitor();
  const finished = items.filter((i) => i.tab.state === 'idle').slice(0, 6);
  if (items.length === 0) return null;
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">Precisando de você</h2>
        <span className="text-xs text-fg-dim">{needsYou.length === 0 ? 'ninguém esperando' : `${needsYou.length} esperando`}</span>
        {!connected && <span className="ml-auto text-[11px] text-warn">reconectando…</span>}
      </div>
      <ul className="space-y-2">
        {needsYou.map((i) => (
          <Item key={i.tab.id} item={i} now={now} />
        ))}
        {finished.map((i) => (
          <Item key={i.tab.id} item={i} now={now} />
        ))}
      </ul>
    </section>
  );
}
