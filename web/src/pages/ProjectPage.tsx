import { NavLink, useParams } from 'react-router-dom';
import { useData } from '../lib/data';
import { PROJECT_STATUS_LABEL } from '../lib/types';
import { TerminalsView } from '../components/TerminalsView';
import { FullScreenMessage } from '../components/Layout';

export type ProjectSection = 'terminals';

const SECTIONS: { key: ProjectSection; label: string; path: string }[] = [{ key: 'terminals', label: 'Terminais', path: '' }];

export function ProjectPage() {
  const { id, section } = useParams<{ id: string; section?: string }>();
  const { projects, machines, statuses, loading } = useData();
  const project = projects.find((p) => p.id === id);
  const current: ProjectSection = (SECTIONS.find((s) => s.path === (section ?? ''))?.key ?? 'terminals') as ProjectSection;

  if (loading) return <FullScreenMessage>Carregando…</FullScreenMessage>;
  if (!project) return <FullScreenMessage>Projeto não encontrado.</FullScreenMessage>;
  const machine = machines.find((m) => m.id === project.machine_id);
  const status = machine ? (statuses[machine.id] ?? 'checking') : 'offline';

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-bg-2 px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="truncate font-semibold">{project.name}</span>
            {project.status !== 'active' && (
              <span className="rounded bg-bg-4 px-1.5 text-[10px] text-fg-muted">{PROJECT_STATUS_LABEL[project.status]}</span>
            )}
          </div>
        </div>
        <span className="hidden truncate font-mono text-xs text-fg-dim md:inline" title={project.cwd}>
          {machine?.name}:{project.cwd}
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${status === 'online' ? 'bg-ok' : status === 'offline' ? 'bg-danger' : 'bg-warn animate-pulse'}`} title={status} />
        <nav className="ml-auto flex items-center gap-1 text-xs">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.key}
              to={`/projects/${project.id}${s.path ? '/' + s.path : ''}`}
              end
              className={({ isActive }) => `rounded px-2 py-1 ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:text-fg'}`}
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* Terminais ficam montados mesmo em outras seções: trocar de aba não reconecta. */}
        <TerminalsView key={project.id} project={project} visible={current === 'terminals'} />
      </div>
    </div>
  );
}
