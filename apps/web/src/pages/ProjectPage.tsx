import { useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useData } from '../lib/data';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { PROJECT_STATUS_LABEL, type Project } from '../lib/types';
import { TerminalsView } from '../components/TerminalsView';
import { TasksBoard } from '../components/TasksBoard';
import { NotesEditor } from '../components/NotesEditor';
import { TicketsView } from '../components/TicketsView';
import { ProjectSettings } from '../components/ProjectSettings';
import { NicknameDialog } from '../components/NicknameDialog';
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
  const { projects, machines, statuses, loading } = useData();
  const project = projects.find((p) => p.id === id);
  const current: ProjectSection = SECTIONS.find((s) => s.path === (section ?? ''))?.key ?? 'terminals';

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
          <ProjectSettings key={`settings-${project.id}-${project.status}-${project.cwd}-${project.name}`} project={project} />
        )}
      </div>
    </div>
  );
}

/**
 * Publishes the project's rooms to the owner's public city. Publishing is a one-way disclosure — it
 * makes readable, to anyone with the link, the project's name, the machine's name and every tab in
 * it with what each one is doing — so turning it ON asks for a separate confirmation, spelling that
 * out; turning it back OFF does not, since there is nothing new to warn about. The server is the
 * only source of truth for whether this is allowed (owner, machine owned, nickname claimed): this
 * component reacts to its 403/409 codes and never re-implements those rules.
 */
function PublishControl({ project }: { project: Project }) {
  const { user } = useAuth();
  const { updateProject } = useData();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsNickname, setNeedsNickname] = useState(false);

  const publish = async (next: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await updateProject(project.id, { is_public: next });
      setConfirming(false);
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code;
      if (code === 'NICKNAME_REQUIRED') setNeedsNickname(true);
      else setError(err instanceof ApiError ? err.message : 'Erro ao publicar');
    } finally {
      setBusy(false);
    }
  };

  // The client-side nickname check lives only here, never inside `publish` itself: `publish` is also
  // what the nickname dialog's own `onSaved` retries right after claiming one, and by then `user` may
  // still be the stale, pre-update value from the render that opened the dialog — checking it there
  // again would risk bouncing straight back to the dialog it just closed.
  const confirmPublish = () => {
    if (!user?.nickname) {
      setNeedsNickname(true);
      return;
    }
    void publish(true);
  };

  const onToggle = () => {
    setError(null);
    if (project.is_public) void publish(false);
    else setConfirming((c) => !c);
  };

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        role="switch"
        aria-checked={project.is_public || confirming}
        aria-label="Publicar"
        title={project.is_public ? 'Deixar de publicar' : 'Publicar na cidade pública'}
        disabled={busy}
        onClick={onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${project.is_public ? 'bg-accent' : 'bg-bg-4'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${project.is_public ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
      {confirming && (
        <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg border border-line bg-bg-2 p-3 text-xs shadow-lg">
          <p className="text-fg-muted">
            Publicar deixa visível, para quem tiver o link, o nome do projeto, o nome da máquina e todas as abas dele, com o que cada uma está fazendo.
          </p>
          {error && <p className="mt-2 text-danger">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
            <button type="button" className="btn-primary" disabled={busy} onClick={confirmPublish}>
              Publicar
            </button>
          </div>
        </div>
      )}
      <NicknameDialog
        open={needsNickname}
        onClose={() => setNeedsNickname(false)}
        onSaved={() => {
          setNeedsNickname(false);
          void publish(true);
        }}
      />
    </div>
  );
}
