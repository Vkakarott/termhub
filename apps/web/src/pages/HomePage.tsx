import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useData } from '../lib/data';
import type { DashboardItem } from '../lib/types';
import { NeedsYouList } from '../components/NeedsYouList';
import { ProjectCards } from '../components/ProjectCards';
import { PageFrame } from '../components/PageHeader';

/** Início: the projects dashboard. Contas de IA, Hardware and Waitlist live in Configurações. */
export function HomePage() {
  return (
    <PageFrame title="Início">
      <Dashboard />
    </PageFrame>
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
          <h2 className="text-lg font-semibold">O que estou fazendo</h2>
          <p className="text-sm text-fg-muted">
            {items ? `${items.length} projeto(s) ativo(s) · ${totalDoing} em andamento · ${totalOpen} aberta(s)` : 'Carregando…'}
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-danger">Não foi possível carregar o dashboard.</p>}
      {items && items.length === 0 && (
        <p className="text-sm text-fg-dim">Nenhum projeto ativo. Clique em "+ projeto" na sidebar.</p>
      )}

      {items && <ProjectCards items={items} statuses={statuses} />}
    </div>
  );
}
