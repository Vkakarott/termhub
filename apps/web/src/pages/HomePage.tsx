import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useData } from '../lib/data';
import { useAuth } from '../lib/auth';
import type { DashboardItem } from '../lib/types';
import { AiAccountsView } from '../components/AiAccountsView';
import { HardwareView } from '../components/HardwareView';
import { WaitlistView } from '../components/WaitlistView';
import { NeedsYouList } from '../components/NeedsYouList';
import { ProjectsByMachine } from '../components/ProjectsByMachine';

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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

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
      <NeedsYouList now={now} />
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

      {items && <ProjectsByMachine items={items} statuses={statuses} />}
    </div>
  );
}
