import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData, type MachineStatus } from '../lib/data';
import type { Machine } from '../lib/types';
import { MachineForm } from './MachineForm';
import { ProjectForm } from './ProjectForm';
import { ConfirmDialog } from './Modal';

const STATUS_DOT: Record<MachineStatus, string> = {
  checking: 'bg-warn animate-pulse',
  online: 'bg-ok',
  offline: 'bg-danger',
};
const STATUS_LABEL: Record<MachineStatus, string> = { checking: 'verificando', online: 'online', offline: 'offline' };

export function Sidebar() {
  const { user, logout } = useAuth();
  const { machines, projects, statuses, missingTmux, loading, deleteMachine, checkStatus } = useData();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [machineForm, setMachineForm] = useState<{ open: boolean; machine?: Machine | null }>({ open: false });
  const [projectForm, setProjectForm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Machine | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const visibleProjects = projects.filter((p) => showArchived || p.status !== 'archived');
  const hasArchived = projects.some((p) => p.status === 'archived');

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-bg-2">
      <div className="flex h-11 items-center justify-between border-b border-line px-3">
        <NavLink to="/" className="text-sm font-semibold tracking-tight">
          <span className="text-accent">▮</span> termhub
        </NavLink>
        <button className="btn-ghost px-2 py-1 text-xs" title="Nova máquina" onClick={() => setMachineForm({ open: true, machine: null })}>
          + máquina
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto py-2">
        {loading && <p className="px-3 py-2 text-xs text-fg-dim">Carregando…</p>}
        {!loading && machines.length === 0 && <p className="px-3 py-2 text-xs text-fg-dim">Nenhuma máquina cadastrada.</p>}
        {machines.map((m) => {
          const status = statuses[m.id] ?? 'checking';
          const mProjects = visibleProjects.filter((p) => p.machine_id === m.id);
          const isCollapsed = collapsed[m.id];
          return (
            <div key={m.id} className="mb-1">
              <div className="group flex items-center gap-1.5 px-2 py-1 text-sm">
                <button
                  className="w-4 text-center text-[10px] text-fg-dim hover:text-fg"
                  onClick={() => setCollapsed((c) => ({ ...c, [m.id]: !c[m.id] }))}
                  aria-label={isCollapsed ? 'Expandir' : 'Recolher'}
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
                <span
                  className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[status]}`}
                  title={`${STATUS_LABEL[status]} — clique para verificar`}
                  onClick={() => void checkStatus(m.id)}
                />
                <span className="truncate font-medium" title={m.type === 'ssh' ? `${m.ssh_user ? m.ssh_user + '@' : ''}${m.host}:${m.ssh_port}` : 'local'}>
                  {m.name}
                </span>
                {missingTmux[m.id] && (
                  <span className="text-[10px] text-warn" title="tmux não está instalado nesta máquina">
                    sem tmux
                  </span>
                )}
                <span className="ml-auto hidden items-center gap-0.5 group-hover:flex">
                  <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title="Novo projeto" onClick={() => setProjectForm(m.id)}>
                    +
                  </button>
                  <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title="Editar" onClick={() => setMachineForm({ open: true, machine: m })}>
                    ✎
                  </button>
                  {m.type !== 'local' && (
                    <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-danger" title="Excluir" onClick={() => setDeleting(m)}>
                      ✕
                    </button>
                  )}
                </span>
              </div>
              {!isCollapsed && (
                <ul className="ml-4 border-l border-line pl-1">
                  {mProjects.length === 0 && (
                    <li>
                      <button className="px-3 py-1 text-xs text-fg-dim hover:text-fg" onClick={() => setProjectForm(m.id)}>
                        + novo projeto
                      </button>
                    </li>
                  )}
                  {mProjects.map((p) => (
                    <li key={p.id}>
                      <NavLink
                        to={`/projects/${p.id}`}
                        className={({ isActive }) =>
                          `flex items-center gap-2 rounded-r px-3 py-1 text-sm ${isActive ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`
                        }
                        title={p.cwd}
                      >
                        <span className={`truncate ${p.status !== 'active' ? 'opacity-60' : ''}`}>{p.name}</span>
                        {!!p.open_tasks && p.status === 'active' && (
                          <span className="ml-auto rounded-full bg-bg-4 px-1.5 text-[10px] tabular-nums text-fg-muted" title={`${p.open_tasks} task(s) aberta(s)`}>
                            {p.open_tasks}
                          </span>
                        )}
                        {p.status === 'paused' && <span className="ml-auto text-[10px] text-warn">pausado</span>}
                        {p.status === 'archived' && <span className="ml-auto text-[10px] text-fg-dim">arquivado</span>}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {hasArchived && (
          <button className="mt-2 px-3 text-xs text-fg-dim hover:text-fg" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Ocultar arquivados' : 'Mostrar arquivados'}
          </button>
        )}
      </nav>

      <div className="flex items-center gap-2 border-t border-line px-3 py-2">
        {user?.avatar_url ? (
          <img src={user.avatar_url} alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-bg-4 text-xs font-semibold">
            {user?.name?.[0]?.toUpperCase() ?? '?'}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={user?.email}>
          {user?.name}
        </span>
        <button
          className="text-xs text-fg-dim hover:text-fg"
          onClick={() => {
            void logout().then(() => navigate('/login'));
          }}
        >
          Sair
        </button>
      </div>

      {machineForm.open && (
        <MachineForm key={machineForm.machine?.id ?? 'new'} open onClose={() => setMachineForm({ open: false })} machine={machineForm.machine} />
      )}
      {projectForm && <ProjectForm open onClose={() => setProjectForm(null)} machineId={projectForm} />}
      <ConfirmDialog
        open={!!deleting}
        title="Excluir máquina"
        message={
          <>
            Excluir <strong>{deleting?.name}</strong>? Só é possível se ela não tiver projetos.
          </>
        }
        confirmLabel="Excluir"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteMachine(deleting.id);
          } catch (e) {
            alert((e as Error).message);
          }
          setDeleting(null);
        }}
      />
    </aside>
  );
}
