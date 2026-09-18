import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useData } from '../lib/data';
import { useAuth } from '../lib/auth';
import type { DashboardItem } from '../lib/types';
import { AiAccountsView } from '../components/AiAccountsView';
import { HardwareView } from '../components/HardwareView';
import { WaitlistView } from '../components/WaitlistView';

function relative(iso: string | null): string {
  if (!iso) return 'nunca';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `há ${d} dia${d > 1 ? 's' : ''}`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

/** Home tabs; each one is shown only when the user's role grants its resource. */
const TABS: { path: string; label: string; resource: string }[] = [
  { path: '/', label: 'Projetos', resource: 'projects' },
  { path: '/ai', label: 'Contas de IA', resource: 'ai_accounts' },
  { path: '/hardware', label: 'Hardware', resource: 'hardware' },
  { path: '/waitlist', label: 'Waitlist', resource: 'waitlist' },
];

export function HomePage() {
  const { pathname } = useLocation();
  const { can } = useAuth();
  const tabs = TABS.filter((t) => t.resource === 'projects' || can(t.resource));
  const allowed = tabs.some((t) => t.path === pathname);
  return (
    <div className="flex h-full flex-col">
      <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-bg-2 px-4">
        {tabs.map((t) => (
          <NavLink
            key={t.path}
            to={t.path}
            end
            className={({ isActive }) => `rounded px-3 py-1 text-sm ${isActive ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">{!allowed ? <p className="text-sm text-fg-dim">Sem permissão para esta aba.</p> : pathname === '/ai' ? <AiAccountsView /> : pathname === '/hardware' ? <HardwareView /> : pathname === '/waitlist' ? <WaitlistView /> : <Dashboard />}</div>
    </div>
  );
}

function Dashboard() {
  const { statuses, projects } = useData();
  const [items, setItems] = useState<DashboardItem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.dashboard()
      .then((r) => !cancelled && setItems(r.items))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
    // recarrega quando a lista de projetos mudar (criação/status/contadores)
  }, [projects]);

  const totalDoing = items?.reduce((n, i) => n + i.doing.length, 0) ?? 0;
  const totalOpen = items?.reduce((n, i) => n + i.open_tasks, 0) ?? 0;

  return (
    <div>
      <div className="mb-5 flex items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">O que estou fazendo</h1>
          <p className="text-sm text-fg-muted">
            {items ? `${items.length} projeto(s) ativo(s) · ${totalDoing} em andamento · ${totalOpen} aberta(s)` : 'Carregando…'}
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-danger">Não foi possível carregar o dashboard.</p>}
      {items && items.length === 0 && (
        <p className="text-sm text-fg-dim">Nenhum projeto ativo. Passe o mouse sobre uma máquina na sidebar e clique em "+".</p>
      )}

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items?.map(({ project: p, machine: m, doing, open_tasks }) => {
          const st = m ? (statuses[m.id] ?? 'checking') : 'offline';
          return (
            <li key={p.id} className="flex flex-col rounded-lg border border-line bg-bg-2 p-4 hover:border-accent/60">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${st === 'online' ? 'bg-ok' : st === 'offline' ? 'bg-danger' : 'bg-warn'}`} title={m?.name} />
                <Link to={`/projects/${p.id}`} className="truncate font-medium hover:underline">
                  {p.name}
                </Link>
                <span className="ml-auto shrink-0 text-xs text-fg-dim">{m?.name ?? '—'}</span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-fg-dim" title={p.cwd}>
                {p.cwd}
              </div>
              {p.description && <p className="mt-2 line-clamp-2 text-xs text-fg-muted">{p.description}</p>}

              <div className="mt-3 flex-1">
                <div className="mb-1 flex items-center text-[11px] uppercase tracking-wide text-fg-dim">
                  <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                  Fazendo
                  <Link to={`/projects/${p.id}/tasks`} className="ml-auto normal-case tracking-normal hover:text-fg">
                    {open_tasks} aberta{open_tasks === 1 ? '' : 's'} →
                  </Link>
                </div>
                {doing.length === 0 ? (
                  <p className="text-xs text-fg-dim">nada em andamento</p>
                ) : (
                  <ul className="space-y-1">
                    {doing.slice(0, 4).map((t) => (
                      <li key={t.id} className="truncate rounded bg-bg-3 px-2 py-1 text-xs" title={t.title}>
                        {t.title}
                      </li>
                    ))}
                    {doing.length > 4 && <li className="px-2 text-xs text-fg-dim">+{doing.length - 4}</li>}
                  </ul>
                )}
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-[11px] text-fg-dim">
                <span>terminal: {relative(p.last_terminal_at)}</span>
                <Link to={`/projects/${p.id}`} className="text-accent hover:underline">
                  abrir terminais
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
