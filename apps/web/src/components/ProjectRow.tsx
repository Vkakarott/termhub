import { Link, NavLink, useNavigate } from 'react-router-dom';
import { tabDotClass } from '../lib/needs-you';
import { TAB_STATE_LABEL, type Machine, type Project, type Tab } from '../lib/types';

interface Props {
  project: Project;
  /** the project's open terminal tabs ("agents"), already ordered */
  agents: Tab[];
  /** the project's linked machines: the agent rows name their machine only when there are several */
  machines: Machine[];
  /** how many of its tabs are waiting for you */
  waiting: number;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}

/** One project in the sidebar: its link and actions, and its running agents underneath. */
export function ProjectRow({ project: p, agents, machines, waiting, expanded, onToggle, onDelete }: Props) {
  const navigate = useNavigate();
  const hasAgents = agents.length > 0;
  const showMachine = machines.length > 1;
  return (
    <li className="mb-0.5">
      <div className="group/p flex items-center rounded-r hover:bg-bg-3">
        {hasAgents ? (
          <button
            type="button"
            className="w-5 shrink-0 py-1 text-center text-[9px] text-fg-dim hover:text-fg"
            title={expanded ? 'Recolher' : 'Expandir'}
            aria-label={`${expanded ? 'Recolher' : 'Expandir'} agentes de ${p.name}`}
            aria-expanded={expanded}
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
        {/* actions: hover only; outside the link so clicking them does not navigate */}
        <span className="hidden shrink-0 items-center gap-0.5 pr-1 group-hover/p:flex">
          <button type="button" className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg" title="Editar projeto" onClick={() => navigate(`/projects/${p.id}/settings`)}>
            ✎
          </button>
          <button type="button" className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger" title="Excluir projeto (as pastas nas máquinas não são apagadas)" onClick={onDelete}>
            ✕
          </button>
        </span>
      </div>
      {hasAgents && expanded && (
        <ul className="ml-4 border-l border-line pl-2" aria-label={`Agentes de ${p.name}`}>
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
