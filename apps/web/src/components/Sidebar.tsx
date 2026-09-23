import { useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { canSeeSettings } from '../lib/settings-sections';
import { ANALYTICS_ENABLED } from '../lib/analytics';
import { openCookieBanner } from './AnalyticsGate';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { needsYouByProject } from '../lib/needs-you';
import { applyDrop, buildSections, type DragSource, type Section, type SectionId } from '../lib/project-groups-model';
import { useProjectGroups } from '../lib/project-groups';
import { decodeGroupDrag, decodeProjectDrag, encodeProjectDrag, GROUP_MIME, PROJECT_MIME, slotFor } from '../lib/sidebar-dnd';
import { loadCollapsedGroups, loadCollapsedProjects, saveCollapsedGroups, saveCollapsedProjects } from '../lib/sidebar-prefs';
import type { Project, ProjectGroup, Tab } from '../lib/types';
import { GroupHeader } from './GroupHeader';
import { ProjectForm } from './ProjectForm';
import { ProjectGroupsMenu } from './ProjectGroupsMenu';
import { ProjectRow } from './ProjectRow';
import { ConfirmDialog } from './Modal';
import { ViewAsSwitch } from './ViewAsSwitch';

const SECTION_LABEL = 'px-3 pb-1 pt-1 text-[10px] uppercase tracking-wide text-fg-dim';

/** Open terminal tabs ("agents") per project, in tab-bar order: position, then name. */
function agentsByProject(tabs: Tab[]): Map<string, Tab[]> {
  const byProject = new Map<string, Tab[]>();
  for (const tab of tabs) {
    const list = byProject.get(tab.project_id);
    if (list) list.push(tab);
    else byProject.set(tab.project_id, [tab]);
  }
  for (const list of byProject.values()) list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  return byProject;
}

/** what is being dragged in the sidebar: a project row, or a group header */
type Drag = { kind: 'project'; source: DragSource } | { kind: 'group'; groupId: string };
/** where a dragged project would land: `slot` counts the section's visible rows */
type DropAt = { to: SectionId; slot: number };
/** a section that is a group, as opposed to Em execução and Outros: Alt copies out of it, Outros takes projects out of it */
const isGroupSection = (id: SectionId) => id !== 'running' && id !== 'others';
const LINE_ABOVE = 'border-t-2 border-accent';
const LINE_BELOW = 'border-b-2 border-accent';

/**
 * Accessible names for the sections, unique across the sidebar: group names can repeat, or equal
 * "Em execução"/"Outros". Those two keep their label; a group whose label is taken gets " (2)", " (3)"…
 * The visible label never changes.
 */
function sectionNames(sections: Section[]): Map<SectionId, string> {
  const taken = new Set(sections.filter((s) => !isGroupSection(s.id)).map((s) => s.label));
  const names = new Map<SectionId, string>();
  for (const s of sections) {
    if (!isGroupSection(s.id)) {
      names.set(s.id, s.label);
      continue;
    }
    let name = s.label;
    for (let n = 2; taken.has(name); n++) name = `${s.label} (${n})`;
    taken.add(name);
    names.set(s.id, name);
  }
  return names;
}

export function Sidebar({ onCollapse }: { onCollapse?: () => void }) {
  const { user, logout, can } = useAuth();
  const { projects, machinesOf, loading, deleteProject } = useData();
  const { items: monitorItems, openTabs, needsYou } = useMonitor();
  const waiting = useMemo(() => needsYouByProject(monitorItems), [monitorItems]);
  // every open terminal tab, reported a state or not: "Em execução" means a tab is open
  const agents = useMemo(() => agentsByProject(openTabs), [openTabs]);
  const navigate = useNavigate();
  const location = useLocation();
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsedState] = useState<Set<string>>(loadCollapsedProjects);
  const { groups, error: groupsError, createGroup, renameGroup, deleteGroup, reorderGroups, setMemberships, isFavorite, toggleFavorite } = useProjectGroups();
  const [collapsedGroups, setCollapsedGroupsState] = useState<Set<string>>(loadCollapsedGroups);
  /** the group "+ grupo" just created: its header opens in rename mode */
  const [newGroupId, setNewGroupId] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<ProjectGroup | null>(null);
  /** the open Grupos… menu; `key` changes per opening so a menu never inherits another row's state */
  const [menuFor, setMenuFor] = useState<{ projectId: string; anchor: HTMLElement; key: number } | null>(null);
  // the drag in progress: browsers hide dataTransfer's data during dragover (only its types show), so it is kept here too
  const dragRef = useRef<Drag | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  /** the group header a dragged group would land on, and on which side of it */
  const [groupDropAt, setGroupDropAt] = useState<{ id: string; below: boolean } | null>(null);

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

  const setCollapsedGroups = (next: Set<string>) => {
    setCollapsedGroupsState(next);
    saveCollapsedGroups(next);
  };
  const toggleGroup = (id: string) => {
    const next = new Set(collapsedGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsedGroups(next);
  };

  // one visibility rule for every section: archived projects only when asked for
  const visibleProjects = projects.filter((p) => showArchived || p.status !== 'archived');
  const hasArchived = projects.some((p) => p.status === 'archived');
  const running = visibleProjects.filter((p) => agents.has(p.id));
  const sections = buildSections(projects, groups, new Set(agents.keys()), showArchived);
  const names = sectionNames(sections);
  const nameOf = (section: Section) => names.get(section.id) ?? section.label;
  const anyExpanded = running.some((p) => !collapsed.has(p.id));

  const toggleAll = () => {
    const next = new Set(collapsed);
    for (const p of running) {
      if (anyExpanded) next.add(p.id);
      else next.delete(p.id);
    }
    setCollapsed(next);
  };

  const endDrag = () => {
    dragRef.current = null;
    setDropAt(null);
    setGroupDropAt(null);
  };
  // The ref stands in for the data only while the drag carries our type: if the source row unmounted
  // mid-drag (no dragend), a stale ref must not make a foreign drag, such as an OS file, look like ours.
  const carries = (e: DragEvent, mime: string) => Array.from(e.dataTransfer?.types ?? []).includes(mime);
  const draggedProject = (e: DragEvent): DragSource | null =>
    decodeProjectDrag(e.dataTransfer?.getData(PROJECT_MIME) ?? '') ??
    (dragRef.current?.kind === 'project' && carries(e, PROJECT_MIME) ? dragRef.current.source : null);
  const draggedGroup = (e: DragEvent): string | null =>
    decodeGroupDrag(e.dataTransfer?.getData(GROUP_MIME) ?? '') ?? (dragRef.current?.kind === 'group' && carries(e, GROUP_MIME) ? dragRef.current.groupId : null);
  const sortedGroups = [...groups].sort((a, b) => a.position - b.position);

  /** A visible slot → the index in the group's project_ids, which may also hold projects this list hides (archived ones). */
  const groupIndex = (section: Section, slot: number) => {
    const ids = groups.find((g) => g.id === section.id)?.project_ids ?? [];
    const at = slot < section.projects.length ? ids.indexOf(section.projects[slot].id) : -1;
    return at === -1 ? ids.length : at;
  };

  /** Handlers that take a dragged project into `section` at `slot(e)`. Em execução never gets them: it is not a drop target. */
  const projectDropTarget = (section: Section, slot: (e: DragEvent<HTMLElement>) => number): HTMLAttributes<HTMLElement> => {
    // Outros only takes a project out of a group: from Em execução or Outros itself nothing would change
    const accepts = (src: DragSource | null): src is DragSource => !!src && (section.kind !== 'others' || isGroupSection(src.from));
    return {
      onDragOver: (e) => {
        const src = draggedProject(e);
        if (!accepts(src)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = e.altKey && isGroupSection(src.from) ? 'copy' : 'move';
        const at = slot(e);
        setDropAt((cur) => (cur?.to === section.id && cur.slot === at ? cur : { to: section.id, slot: at }));
      },
      onDrop: (e) => {
        const src = draggedProject(e);
        if (!accepts(src)) return;
        e.preventDefault();
        e.stopPropagation();
        const index = section.kind === 'others' ? 0 : groupIndex(section, slot(e));
        endDrag();
        const result = applyDrop(groups, src, { to: section.id, index }, { copy: e.altKey });
        if (result) void setMemberships(result.next, result.changes);
      },
    };
  };
  const leaveSection = (e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
  };

  /** Favoritos and custom group headers: dragged to reorder the groups, and where a dragged group lands. */
  const headerDragProps = (section: Section): HTMLAttributes<HTMLDivElement> => {
    const index = sortedGroups.findIndex((g) => g.id === section.id);
    return {
      draggable: true,
      className: groupDropAt?.id === section.id ? (groupDropAt.below ? LINE_BELOW : LINE_ABOVE) : '',
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(GROUP_MIME, section.id);
        dragRef.current = { kind: 'group', groupId: section.id };
      },
      onDragEnd: endDrag,
      onDragOver: (e) => {
        const id = draggedGroup(e);
        // a project bubbles on to the section: dropped on a header, it goes to the end of that group
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        // moving down, the group lands after this header; moving up, before it
        const below = sortedGroups.findIndex((g) => g.id === id) < index;
        setGroupDropAt((cur) => (cur?.id === section.id && cur.below === below ? cur : { id: section.id, below }));
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setGroupDropAt(null);
      },
      onDrop: (e) => {
        const id = draggedGroup(e);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        endDrag();
        if (id !== section.id && index !== -1) void reorderGroups(id, index);
      },
    };
  };

  const addGroup = async () => {
    const group = await createGroup('Novo grupo');
    if (group) setNewGroupId(group.id);
  };

  const row = (section: Section) => (p: Project, i: number) => {
    const inGroup = isGroupSection(section.id);
    const here = inGroup && dropAt?.to === section.id;
    const last = i === section.projects.length - 1;
    const dragProps: HTMLAttributes<HTMLLIElement> = {
      draggable: true,
      className: here && dropAt?.slot === i ? LINE_ABOVE : here && last && dropAt?.slot === section.projects.length ? LINE_BELOW : '',
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = 'copyMove';
        const source = { projectId: p.id, from: section.id };
        e.dataTransfer.setData(PROJECT_MIME, encodeProjectDrag(source));
        dragRef.current = { kind: 'project', source };
      },
      onDragEnd: endDrag,
      // a group's row places the project before or after itself; in Outros the section takes it, in Em execução nothing does
      ...(inGroup ? projectDropTarget(section, (e) => slotFor(i, e.clientY, e.currentTarget.getBoundingClientRect())) : {}),
    };
    return (
      <ProjectRow
        // a project can show in several sections
        key={`${section.id}:${p.id}`}
        project={p}
        section={nameOf(section)}
        agents={agents.get(p.id) ?? []}
        machines={machinesOf(p)}
        waiting={waiting.get(p.id) ?? 0}
        expanded={!collapsed.has(p.id)}
        onToggle={() => toggleProject(p.id)}
        onDelete={() => {
          setDeleteError(null);
          setDeletingProject(p);
        }}
        favorite={isFavorite(p.id)}
        onToggleFavorite={() => void toggleFavorite(p.id)}
        // the same button closes it; any other ⋯ (even the same project in another section) moves it there
        onOpenGroups={(anchor) => setMenuFor((cur) => (cur?.anchor === anchor ? null : { projectId: p.id, anchor, key: (cur?.key ?? 0) + 1 }))}
        dragProps={dragProps}
      />
    );
  };

  const renderSection = (section: Section) => {
    if (section.kind === 'running') {
      return (
        <section key={section.id} aria-label={nameOf(section)} className="mb-2">
          <p className={SECTION_LABEL}>{section.label}</p>
          <ul>{section.projects.map(row(section))}</ul>
        </section>
      );
    }
    // Outros renders even when empty: dropping a project there takes it out of its groups
    const isOthers = section.kind === 'others';
    const group = groups.find((g) => g.id === section.id);
    const open = !collapsedGroups.has(section.id);
    const over = dropAt?.to === section.id;
    return (
      <section
        key={section.id}
        aria-label={nameOf(section)}
        // Outros has no order and a collapsed group shows no rows: the whole section lights up instead of a line
        className={`mb-2 ${over && (isOthers || !open) ? 'rounded ring-1 ring-accent' : ''}`}
        // dropped on the header, the list's padding or the empty hint, a project goes to the end
        {...projectDropTarget(section, () => section.projects.length)}
        onDragLeave={leaveSection}
      >
        <GroupHeader
          section={section}
          name={nameOf(section)}
          collapsed={!open}
          onToggle={() => toggleGroup(section.id)}
          editable={section.kind === 'custom'}
          startEditing={section.id === newGroupId}
          onRename={(name) => void renameGroup(section.id, name)}
          onEditEnd={() => setNewGroupId((cur) => (cur === section.id ? null : cur))}
          onDelete={() => group && setDeletingGroup(group)}
          headerDragProps={isOthers ? undefined : headerDragProps(section)}
        />
        {open && section.projects.length > 0 && <ul>{section.projects.map(row(section))}</ul>}
        {open && !isOthers && section.projects.length === 0 && (
          <p className={`mx-3 my-1 rounded border border-dashed px-2 py-1.5 text-center text-[11px] ${over ? 'border-accent text-fg' : 'border-line text-fg-dim'}`}>
            arraste projetos para cá
          </p>
        )}
        {open && isOthers && hasArchived && (
          <button className="mt-1 px-3 text-xs text-fg-dim hover:text-fg" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Ocultar arquivados' : 'Mostrar arquivados'}
          </button>
        )}
      </section>
    );
  };

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

        <div className="flex items-center pr-2">
          <p className={`${SECTION_LABEL} flex-1`}>Projetos</p>
          {running.length > 0 && (
            <button
              type="button"
              className="rounded px-1 text-[10px] text-fg-dim hover:bg-bg-3 hover:text-fg"
              title={anyExpanded ? 'Recolher todos' : 'Expandir todos'}
              aria-label={anyExpanded ? 'Recolher todos' : 'Expandir todos'}
              aria-expanded={anyExpanded}
              onClick={toggleAll}
            >
              {anyExpanded ? '⊟' : '⊞'}
            </button>
          )}
          <button type="button" className="rounded px-1 text-[10px] text-fg-dim hover:bg-bg-3 hover:text-fg" title="Novo grupo" onClick={() => void addGroup()}>
            + grupo
          </button>
        </div>
        {groupsError && (
          <p role="alert" className="px-3 text-[11px] text-danger">
            {groupsError}
          </p>
        )}
        {!loading && visibleProjects.length === 0 && (
          <button className="px-3 py-1 text-xs text-fg-dim hover:text-fg" onClick={() => setProjectFormOpen(true)}>
            + novo projeto
          </button>
        )}

        {sections.map(renderSection)}
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
      {menuFor && <ProjectGroupsMenu key={menuFor.key} projectId={menuFor.projectId} anchor={menuFor.anchor} onClose={() => setMenuFor(null)} />}
      <ConfirmDialog
        open={!!deletingGroup}
        title="Excluir grupo"
        message={`Excluir o grupo "${deletingGroup?.name ?? ''}"? Os projetos não são apagados.`}
        confirmLabel="Excluir"
        danger
        onCancel={() => setDeletingGroup(null)}
        onConfirm={async () => {
          if (!deletingGroup) return;
          const id = deletingGroup.id;
          setDeletingGroup(null);
          if (collapsedGroups.has(id)) {
            const next = new Set(collapsedGroups);
            next.delete(id);
            setCollapsedGroups(next);
          }
          await deleteGroup(id);
        }}
      />
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
