import { useId, type HTMLAttributes } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { tabDotClass } from '../lib/needs-you';
import { TAB_STATE_LABEL, type Machine, type Project, type Tab } from '../lib/types';

interface Props {
  project: Project;
  /** the section showing this row: a running project shows in two, and its lists must be told apart */
  section: string;
  /** the project's open terminal tabs ("agents"), already ordered */
  agents: Tab[];
  /** the project's linked machines: the agent rows name their machine only when there are several */
  machines: Machine[];
  /** how many of its tabs are waiting for you */
  waiting: number;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  /** in Favoritos: the pin is pressed and always shown */
  favorite: boolean;
  onToggleFavorite: () => void;
  /** opens the "Grupos…" menu under the given button */
  onOpenGroups: (anchor: HTMLElement) => void;
  /** drag-and-drop handlers for moving the row between groups; filled by the sidebar's drag layer */
  dragProps?: HTMLAttributes<HTMLLIElement>;
}

/** One project in the sidebar: its link and actions, and its running agents underneath. */
export function ProjectRow({ project: p, section, agents, machines, waiting, expanded, onToggle, onDelete, favorite, onToggleFavorite, onOpenGroups, dragProps }: Props) {
  const navigate = useNavigate();
  const hasAgents = agents.length > 0;
  const showMachine = machines.length > 1;
  const listId = useId();
  const pinLabel = favorite ? 'Tirar de Favoritos' : 'Fixar em Favoritos';
  const pin = (
    <button
      type="button"
      className={`rounded px-1 text-xs hover:bg-bg-4 ${favorite ? 'text-accent opacity-70 hover:opacity-100' : 'text-fg-dim opacity-60 grayscale hover:text-fg hover:opacity-100'}`}
      title={pinLabel}
      aria-label={pinLabel}
      aria-pressed={favorite}
      onClick={onToggleFavorite}
    >
      📌
    </button>
  );
  return (
    <li className="mb-0.5" {...dragProps}>
      <div className="group/p flex items-center rounded-r hover:bg-bg-3">
        {hasAgents ? (
          <button
            type="button"
            className="w-5 shrink-0 py-1 text-center text-[9px] text-fg-dim hover:text-fg"
            title={expanded ? 'Recolher' : 'Expandir'}
            aria-label={`${expanded ? 'Recolher' : 'Expandir'} agentes de ${p.name}`}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={onToggle}
          >
            {expanded ? '▼' : '▶'}
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}
        <NavLink
          to={`/projects/${p.id}`}
          className={({ isActive }) =>
            `flex min-w-0 flex-1 items-center gap-2 rounded-r py-1 pr-3 text-sm ${isActive ? 'bg-accent/15 text-fg' : 'text-fg-muted group-hover/p:text-fg'}`
          }
          title={machines.map((m) => m.name).join(', ') || 'sem máquina vinculada'}
        >
          <span className="shrink-0 font-mono text-[10px] text-fg-dim">{p.key}</span>
          <span className={`truncate ${p.status !== 'active' ? 'opacity-60' : ''}`}>{p.name}</span>
          {waiting > 0 && (
            <span
              className="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-attention"
              title={waiting === 1 ? '1 tab esperando você' : `${waiting} tabs esperando você`}
              aria-label="esperando você"
            />
          )}
          {!!p.open_tasks && p.status === 'active' && (
            <span className={`${waiting ? '' : 'ml-auto '}rounded-full bg-bg-4 px-1.5 text-[10px] tabular-nums text-fg-muted group-hover/p:hidden`} title={`${p.open_tasks} task(s) aberta(s)`}>
              {p.open_tasks}
            </span>
          )}
          {p.status === 'paused' && <span className={`${waiting ? '' : 'ml-auto '}text-[10px] text-warn group-hover/p:hidden`}>pausado</span>}
          {p.status === 'archived' && <span className={`${waiting ? '' : 'ml-auto '}text-[10px] text-fg-dim group-hover/p:hidden`}>arquivado</span>}
        </NavLink>
        {/* a favourite's pin stays visible; the other actions show on hover. All outside the link so clicking them does not navigate */}
        {favorite && <span className="flex shrink-0 items-center pr-1 group-hover/p:pr-0">{pin}</span>}
        <span className="hidden shrink-0 items-center gap-0.5 pr-1 group-hover/p:flex">
          {!favorite && pin}
          <button
            type="button"
            className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg"
            title="Grupos…"
            aria-label="Grupos…"
            aria-haspopup="menu"
            onClick={(e) => onOpenGroups(e.currentTarget)}
          >
            ⋯
          </button>
          <button type="button" className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg" title="Editar projeto" onClick={() => navigate(`/projects/${p.id}/settings`)}>
            ✎
          </button>
          <button type="button" className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger" title="Excluir projeto (as pastas nas máquinas não são apagadas)" onClick={onDelete}>
            ✕
          </button>
        </span>
      </div>
      {hasAgents && expanded && (
        <ul id={listId} className="ml-4 border-l border-line pl-2" aria-label={`Agentes de ${p.name} · ${section}`}>
          {agents.map((tab) => {
            const machineName = showMachine ? machines.find((m) => m.id === tab.machine_id)?.name : null;
            return (
              <li key={tab.id}>
                <Link
                  to={`/projects/${p.id}?tab=${tab.id}`}
                  className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs text-fg-muted hover:bg-bg-3 hover:text-fg"
                >
                  {/* an open tab is a live one here: no state = the neutral dot the tab bar shows */}
                  <span data-dot className={`h-1.5 w-1.5 shrink-0 rounded-full ${tabDotClass(true, tab)}`} title={tab.state ? TAB_STATE_LABEL[tab.state] : undefined} />
                  <span className="truncate">{tab.name}</span>
                  {machineName && <span className="shrink-0 truncate text-fg-dim"> · {machineName}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
