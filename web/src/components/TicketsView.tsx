import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { PROVIDER_LABEL, TASK_STATUS_LABEL, type Integration, type Project, type ProjectSetup, type TaskStatus, type Ticket } from '../lib/types';

interface Props {
  project: Project;
}

/** Lista dos tickets sincronizados das integrações; o usuário escolhe quais vão para o backlog. */
export function TicketsView({ project }: Props) {
  const { refresh } = useData();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [setup, setSetup] = useState<ProjectSetup | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TaskStatus | 'all'>('all');
  const [hideImported, setHideImported] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [t, i, s] = await Promise.all([
      api.tickets.list(project.id),
      api.integrations.list().catch(() => ({ integrations: [] })),
      api.setup.get(project.id),
    ]);
    setTickets(t.tickets);
    setIntegrations(i.integrations);
    setSetup(s.setup);
  }, [project.id]);

  useEffect(() => {
    void load().catch((e) => setMsg(e instanceof ApiError ? e.message : 'Erro ao carregar'));
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tickets ?? []).filter(
      (t) =>
        (status === 'all' || t.status === status) &&
        (!hideImported || !t.task_id) &&
        (!q || t.identifier.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || (t.meta.labels ?? []).some((l) => l.toLowerCase().includes(q))),
    );
  }, [tickets, query, status, hideImported]);

  const bySource = useMemo(() => {
    const groups = new Map<string, Ticket[]>();
    for (const t of filtered) {
      const list = groups.get(t.integration_id) ?? [];
      list.push(t);
      groups.set(t.integration_id, list);
    }
    return [...groups.entries()];
  }, [filtered]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const selectable = filtered.filter((t) => !t.task_id);
  const allSelected = selectable.length > 0 && selectable.every((t) => selected.has(t.id));

  const sync = async () => {
    setBusy(true);
    setMsg('sincronizando…');
    try {
      const r = await api.setup.syncTickets(project.id);
      setMsg(`${r.fetched} ticket(s) na fonte · ${r.created} novo(s) · ${r.updated} atualizado(s) · ${r.removed} removido(s)`);
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'falha no sync');
    } finally {
      setBusy(false);
    }
  };

  const importSelected = async () => {
    const ids = [...selected].filter((id) => selectable.some((t) => t.id === id));
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const r = await api.tickets.import(project.id, ids);
      setMsg(`${r.tasks.length} ticket(s) enviado(s) para o backlog`);
      setSelected(new Set());
      await load();
      void refresh();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'falha ao importar');
    } finally {
      setBusy(false);
    }
  };

  if (tickets === null) return <div className="flex h-full items-center justify-center text-sm text-fg-dim">Carregando tickets…</div>;

  const source = setup?.data.tickets;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-2 px-3 py-1.5 text-xs">
        <input className="input w-56 py-1" placeholder="filtrar por id, título, label" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input w-auto py-1" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | 'all')}>
          <option value="all">todos os estados</option>
          {(['backlog', 'todo', 'doing', 'done'] as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-fg-muted">
          <input type="checkbox" checked={hideImported} onChange={(e) => setHideImported(e.target.checked)} className="accent-accent" /> ocultar já no board
        </label>
        <span className="ml-auto text-fg-dim">{msg}</span>
        <button className="btn-ghost border border-line" onClick={() => void sync()} disabled={busy || !source} title={source ? '' : 'configure a fonte no Setup'}>
          Sincronizar
        </button>
        <button className="btn-primary" onClick={() => void importSelected()} disabled={busy || selected.size === 0}>
          Enviar {selected.size > 0 ? `${selected.size} ` : ''}para o backlog
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!source && (
          <p className="text-sm text-fg-dim">
            Nenhuma fonte de tickets configurada. Vá em <Link to={`/projects/${project.id}/settings`} className="text-accent underline">Setup → Tickets</Link>.
          </p>
        )}
        {source && tickets.length === 0 && <p className="text-sm text-fg-dim">Nada sincronizado ainda. Clique em "Sincronizar".</p>}
        {bySource.map(([integrationId, list]) => {
          const integ = integrations.find((i) => i.id === integrationId);
          return (
            <section key={integrationId} className="mb-4">
              <header className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((t) => t.id)) : new Set())}
                  title="selecionar todos os não importados"
                />
                {integ ? `${PROVIDER_LABEL[integ.provider]} · ${integ.name}` : 'fonte removida'}
                {source && <span className="font-mono normal-case text-fg-dim">{source.scope}</span>}
                <span className="ml-auto font-normal normal-case text-fg-dim">{list.length}</span>
              </header>
              <ul className="divide-y divide-line rounded-lg border border-line bg-bg-2">
                {list.map((t) => (
                  <li key={t.id} className={`flex items-start gap-3 px-3 py-2 text-sm ${t.task_id ? 'opacity-60' : ''}`}>
                    <input type="checkbox" className="mt-1 accent-accent" disabled={!!t.task_id} checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <a href={t.url} target="_blank" rel="noreferrer" className="shrink-0 rounded bg-accent/15 px-1 font-mono text-[10px] text-accent hover:bg-accent/25">
                          {t.identifier}
                        </a>
                        <span className="truncate">{t.title}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-fg-dim">
                        <span>{t.state}</span>
                        {t.meta.assignee && <span>{String(t.meta.assignee)}</span>}
                        {(t.meta.labels ?? []).map((l) => (
                          <span key={l} className="rounded bg-bg-4 px-1">
                            {l}
                          </span>
                        ))}
                        {t.task_id && (
                          <Link to={`/projects/${project.id}/tasks`} className="text-ok hover:underline">
                            no board →
                          </Link>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 rounded bg-bg-4 px-1.5 text-[10px] text-fg-muted">{TASK_STATUS_LABEL[t.status]}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
