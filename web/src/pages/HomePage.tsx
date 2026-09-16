import { Link } from 'react-router-dom';
import { useData } from '../lib/data';

export function HomePage() {
  const { machines, projects, statuses } = useData();
  const active = projects.filter((p) => p.status === 'active');
  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-lg font-semibold">Início</h1>
      <p className="mb-6 text-sm text-fg-muted">
        {machines.length} máquina(s), {active.length} projeto(s) ativo(s). Selecione um projeto na barra lateral.
      </p>
      {active.length === 0 ? (
        <p className="text-sm text-fg-dim">Crie um projeto passando o mouse sobre uma máquina e clicando em "+".</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {active.map((p) => {
            const m = machines.find((x) => x.id === p.machine_id);
            const st = m ? (statuses[m.id] ?? 'checking') : 'offline';
            return (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="block rounded-lg border border-line bg-bg-2 p-4 hover:border-accent/60">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${st === 'online' ? 'bg-ok' : st === 'offline' ? 'bg-danger' : 'bg-warn'}`} />
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-auto text-xs text-fg-dim">{m?.name}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-fg-dim">{p.cwd}</div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
