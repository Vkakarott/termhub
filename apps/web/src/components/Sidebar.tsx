import { useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { canSeeSettings } from '../lib/settings-sections';
import { ANALYTICS_ENABLED } from '../lib/analytics';
import { openCookieBanner } from './AnalyticsGate';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { needsYouByProject } from '../lib/needs-you';
import { loadCollapsedProjects, saveCollapsedProjects } from '../lib/sidebar-prefs';
import type { MonitorItem, Project } from '../lib/types';
import { ProjectForm } from './ProjectForm';
import { ProjectRow } from './ProjectRow';
import { ConfirmDialog } from './Modal';
import { ViewAsSwitch } from './ViewAsSwitch';

const SECTION_LABEL = 'px-3 pb-1 pt-1 text-[10px] uppercase tracking-wide text-fg-dim';

/** Open tabs ("agents") per project, in tab-bar order: position, then name. */
function agentsByProject(items: MonitorItem[]): Map<string, MonitorItem[]> {
  const byProject = new Map<string, MonitorItem[]>();
  for (const item of items) {
    const list = byProject.get(item.tab.project_id);
    if (list) list.push(item);
    else byProject.set(item.tab.project_id, [item]);
  }
  for (const list of byProject.values()) list.sort((a, b) => a.tab.position - b.tab.position || a.tab.name.localeCompare(b.tab.name));
  return byProject;
}

/** A labelled group of project rows; `showLabel` false keeps it a named region without the visible header. */
function Section({ label, showLabel = true, children }: { label: string; showLabel?: boolean; children: ReactNode }) {
  return (
    <section aria-label={label} className="mb-2">
      {showLabel && <p className={SECTION_LABEL}>{label}</p>}
      {children}
    </section>
  );
}

export function Sidebar({ onCollapse }: { onCollapse?: () => void }) {
  const { user, logout, can } = useAuth();
  const { projects, machinesOf, loading, deleteProject } = useData();
  const { items: monitorItems, needsYou } = useMonitor();
  const waiting = useMemo(() => needsYouByProject(monitorItems), [monitorItems]);
  const agents = useMemo(() => agentsByProject(monitorItems), [monitorItems]);
  const navigate = useNavigate();
  const location = useLocation();
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsedState] = useState<Set<string>>(loadCollapsedProjects);

  const setCollapsed = (next: Set<string>) => {
    setCollapsedState(next);
    saveCollapsedProjects(next);
  };
  const toggleProject = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  // one visibility rule for every section: archived projects only when asked for
  const visibleProjects = projects.filter((p) => showArchived || p.status !== 'archived');
  const hasArchived = projects.some((p) => p.status === 'archived');
  const running = visibleProjects.filter((p) => agents.has(p.id));
  const anyExpanded = running.some((p) => !collapsed.has(p.id));

  const toggleAll = () => {
    const next = new Set(collapsed);
    for (const p of running) {
      if (anyExpanded) next.add(p.id);
      else next.delete(p.id);
    }
    setCollapsed(next);
  };

  const row = (p: Project) => (
    <ProjectRow
      key={p.id}
      project={p}
      agents={agents.get(p.id) ?? []}
      machines={machinesOf(p)}
      waiting={waiting.get(p.id) ?? 0}
      expanded={!collapsed.has(p.id)}
      onToggle={() => toggleProject(p.id)}
      onDelete={() => {
        setDeleteError(null);
        setDeletingProject(p);
      }}
    />
  );

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-bg-2">
      <div className="flex h-11 items-center justify-between border-b border-line px-3">
        <NavLink to="/" className="text-sm font-semibold tracking-tight">
          <span className="text-accent">▮</span> termhub
        </NavLink>
        <span className="flex items-center gap-0.5">
          {can('projects', 'create') && (
            <button className="btn-ghost px-2 py-1 text-xs" title="Novo projeto" onClick={() => setProjectFormOpen(true)}>
              + novo
            </button>
          )}
          {onCollapse && (
            <button className="rounded px-1.5 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onCollapse} title="Recolher sidebar" aria-label="Recolher sidebar">
              «
            </button>
          )}
        </span>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto py-2">
        {loading && <p className="px-3 py-2 text-xs text-fg-dim">Carregando…</p>}

        <div className="flex items-center justify-between pr-2">
          <p className={SECTION_LABEL}>Projetos</p>
          {running.length > 0 && (
            <button
              type="button"
              className="rounded px-1 text-[10px] text-fg-dim hover:bg-bg-3 hover:text-fg"
              title={anyExpanded ? 'Recolher todos' : 'Expandir todos'}
              aria-label={anyExpanded ? 'Recolher todos' : 'Expandir todos'}
              onClick={toggleAll}
            >
              {anyExpanded ? '⊟' : '⊞'}
            </button>
          )}
        </div>
        {!loading && visibleProjects.length === 0 && (
          <button className="px-3 py-1 text-xs text-fg-dim hover:text-fg" onClick={() => setProjectFormOpen(true)}>
            + novo projeto
          </button>
        )}

        {running.length > 0 && (
          <Section label="Em execução">
            <ul>{running.map(row)}</ul>
          </Section>
        )}
        {visibleProjects.length > 0 && (
          // every project, running ones included; its label only matters when "Em execução" sits above it
          <Section label="Todos os projetos" showLabel={running.length > 0}>
            <ul>{visibleProjects.map(row)}</ul>
          </Section>
        )}
        {hasArchived && (
          <button className="mt-1 px-3 text-xs text-fg-dim hover:text-fg" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Ocultar arquivados' : 'Mostrar arquivados'}
          </button>
        )}
      </nav>

      <ViewAsSwitch />
      <div className="border-t border-line px-3 py-1.5">
        {can('machines') && (
          <NavLink to="/machines" className={({ isActive }) => `block rounded px-2 py-1 text-xs ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}>
            🖥 Máquinas
          </NavLink>
        )}
        {can('projects', 'read') && can('terminals', 'read') && (
          <NavLink to="/office" className={({ isActive }) => `flex items-center justify-between rounded px-2 py-1 text-xs ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}>
            Escritório
            {needsYou.length > 0 && <i className="h-1.5 w-1.5 rounded-full bg-attention" aria-label="alguém precisa de você" />}
          </NavLink>
        )}
        {can('chat') && (
          <NavLink to="/chat" className={({ isActive }) => `block rounded px-2 py-1 text-xs ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}>
            💬 Chat
          </NavLink>
        )}
        {can('integrations') && (
          <NavLink to="/integrations" className={({ isActive }) => `block rounded px-2 py-1 text-xs ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}>
            ⚙ Integrações
          </NavLink>
        )}
        {canSeeSettings(can) && (
          <NavLink to="/settings" className={({ isActive }) => `block rounded px-2 py-1 text-xs ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}>
            ⚙ Configurações
          </NavLink>
        )}
      </div>
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
        {ANALYTICS_ENABLED && (
          <button className="text-xs text-fg-dim hover:text-fg" onClick={openCookieBanner} title="Alterar a escolha sobre cookies">
            Cookies
          </button>
        )}
        <button
          className="text-xs text-fg-dim hover:text-fg"
          onClick={() => {
            void logout().then(() => navigate('/login'));
          }}
        >
          Sair
        </button>
      </div>

      {projectFormOpen && <ProjectForm open onClose={() => setProjectFormOpen(false)} />}
      <ConfirmDialog
        open={!!deletingProject}
        title="Remover projeto"
        message={
          <>
            Remover <strong>{deletingProject?.name}</strong>? As tarefas, notas e tickets do projeto são apagados e as sessões tmux das tabs são encerradas nas
            máquinas vinculadas. As pastas nas máquinas continuam intactas.
            {deleteError && <p className="mt-2 text-danger">{deleteError}</p>}
          </>
        }
        confirmLabel="Remover"
        danger
        onCancel={() => setDeletingProject(null)}
        onConfirm={async () => {
          if (!deletingProject) return;
          try {
            const wasOpen = location.pathname.startsWith(`/projects/${deletingProject.id}`);
            await deleteProject(deletingProject.id);
            setDeletingProject(null);
            if (wasOpen) navigate('/');
          } catch (e) {
            setDeleteError((e as Error).message || 'Erro ao remover');
          }
        }}
      />
    </aside>
  );
}
