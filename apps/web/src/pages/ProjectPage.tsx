import { NavLink, useParams } from 'react-router-dom';
import { useData } from '../lib/data';
import { PROJECT_STATUS_LABEL } from '../lib/types';
import { TerminalsView } from '../components/TerminalsView';
import { TasksBoard } from '../components/TasksBoard';
import { NotesEditor } from '../components/NotesEditor';
import { TicketsView } from '../components/TicketsView';
import { ProjectSettings } from '../components/ProjectSettings';
import { PublishControl } from '../components/PublishControl';
import { FullScreenMessage } from '../components/Layout';

export type ProjectSection = 'terminals' | 'tasks' | 'tickets' | 'notes' | 'settings';

const SECTIONS: { key: ProjectSection; label: string; path: string }[] = [
  { key: 'terminals', label: 'Terminais', path: '' },
  { key: 'tasks', label: 'Tarefas', path: 'tasks' },
  { key: 'tickets', label: 'Tickets', path: 'tickets' },
  { key: 'notes', label: 'Notas', path: 'notes' },
  { key: 'settings', label: 'Setup', path: 'settings' },
];

export function ProjectPage() {
  const { id, section } = useParams<{ id: string; section?: string }>();
  const { projects, machinesOf, statuses, loading } = useData();
  const project = projects.find((p) => p.id === id);
  const current: ProjectSection = SECTIONS.find((s) => s.path === (section ?? ''))?.key ?? 'terminals';

  if (loading) return <FullScreenMessage>Carregando…</FullScreenMessage>;
  if (!project) return <FullScreenMessage>Projeto não encontrado.</FullScreenMessage>;
  const projectMachines = machinesOf(project);
  const online = projectMachines.some((m) => statuses[m.id] === 'online');
  const status =
    projectMachines.length === 0
      ? null
      : online
        ? 'online'
        : projectMachines.every((m) => statuses[m.id] === 'offline')
          ? 'offline'
          : 'checking';

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
        <span className="font-mono text-xs text-fg-dim">{project.key}</span>
        <span className="hidden truncate text-xs text-fg-dim md:inline" title={project.machines.map((l) => l.cwd).join('\n')}>
          {projectMachines.length === 0 ? 'sem máquina' : projectMachines.map((m) => m.name).join(', ')}
        </span>
        {status && (
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${status === 'online' ? 'bg-ok' : status === 'offline' ? 'bg-danger' : 'bg-warn animate-pulse'}`}
            title={status}
          />
        )}
        <PublishControl project={project} />
        <nav className="ml-auto flex items-center gap-1 text-xs">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.key}
              to={`/projects/${project.id}${s.path ? '/' + s.path : ''}`}
              end
              className={({ isActive }) => `rounded px-2 py-1 ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:text-fg'}`}
            >
              {s.label}
              {s.key === 'tasks' && !!project.open_tasks && <span className="ml-1 text-[10px] text-fg-dim">{project.open_tasks}</span>}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* Terminais ficam montados mesmo em outras seções: trocar de aba não reconecta. */}
        <TerminalsView key={`terminals-${project.id}`} project={project} visible={current === 'terminals'} />
        {current === 'tasks' && <TasksBoard key={`tasks-${project.id}`} projectId={project.id} />}
        {current === 'tickets' && <TicketsView key={`tickets-${project.id}`} project={project} />}
        {current === 'notes' && <NotesEditor key={`notes-${project.id}`} projectId={project.id} />}
        {current === 'settings' && (
          // Keyed without `machines`: a link/unlink/cwd-save must not remount this whole subtree —
          // it would wipe the "N tabs fechadas" notice, a row's "Salvo." message and unsaved
          // SetupForm edits. ProjectMachines re-keys its own rows to pick up a saved cwd instead.
          <ProjectSettings key={`settings-${project.id}-${project.status}-${project.name}`} project={project} />
        )}
      </div>
    </div>
  );
}
