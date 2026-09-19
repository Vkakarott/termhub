import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MachineStatus } from '../lib/data';
import type { DashboardItem, Machine } from '../lib/types';

function relative(iso: string | null): string {
  if (!iso) return 'nunca';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `há ${d} dia${d > 1 ? 's' : ''}`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export interface ProjectGroup {
  /** null = projects whose machine is gone */
  machine: Machine | null;
  items: DashboardItem[];
}

const NO_MACHINE = '_none';

/** One group per machine: online ones first, then by name; projects without a machine go last. Items keep their order. */
export function groupByMachine(items: DashboardItem[], statuses: Record<string, MachineStatus>): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const item of items) {
    const key = item.machine?.id ?? NO_MACHINE;
    let g = groups.get(key);
    if (!g) {
      g = { machine: item.machine, items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
  }
  const rank = (g: ProjectGroup) => (!g.machine ? 2 : statuses[g.machine.id] === 'online' ? 0 : 1);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || (a.machine?.name ?? '').localeCompare(b.machine?.name ?? ''));
}

const OPEN_KEY = 'termhub:dashboard-open';

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function ProjectCard({ item: { project: p, doing, open_tasks } }: { item: DashboardItem }) {
  return (
    <li className="flex flex-col rounded-lg border border-line bg-bg-2 p-4 hover:border-accent/60">
      <Link to={`/projects/${p.id}`} className="truncate font-medium hover:underline">
        {p.name}
      </Link>
      <div className="mt-0.5 truncate font-mono text-[11px] text-fg-dim" title={p.cwd}>
        {p.cwd}
      </div>
      {p.description && <p className="mt-2 line-clamp-2 text-xs text-fg-muted">{p.description}</p>}

      <div className="mt-3 flex-1">
        <div className="mb-1 flex items-center text-[11px] uppercase tracking-wide text-fg-dim">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          Fazendo
          <Link to={`/projects/${p.id}/tasks`} className="ml-auto normal-case tracking-normal hover:text-fg">
            {open_tasks} aberta{open_tasks === 1 ? '' : 's'} →
          </Link>
        </div>
        {doing.length === 0 ? (
          <p className="text-xs text-fg-dim">nada em andamento</p>
        ) : (
          <ul className="space-y-1">
            {doing.slice(0, 4).map((t) => (
              <li key={t.id} className="truncate rounded bg-bg-3 px-2 py-1 text-xs" title={t.title}>
                {t.title}
              </li>
            ))}
            {doing.length > 4 && <li className="px-2 text-xs text-fg-dim">+{doing.length - 4}</li>}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-[11px] text-fg-dim">
        <span>terminal: {relative(p.last_terminal_at)}</span>
        <Link to={`/projects/${p.id}`} className="text-accent hover:underline">
          abrir terminais
        </Link>
      </div>
    </li>
  );
}

function MachineSection({ group, status, open, onToggle }: { group: ProjectGroup; status: MachineStatus; open: boolean; onToggle: () => void }) {
  const { machine, items } = group;
  const doing = items.reduce((n, i) => n + i.doing.length, 0);
  const openTasks = items.reduce((n, i) => n + i.open_tasks, 0);
  return (
    <li>
      <button type="button" className="flex w-full items-center gap-2 rounded-lg border border-line bg-bg-2 px-3 py-2 text-left text-sm hover:bg-bg-3" onClick={onToggle} aria-expanded={open}>
        <span className={`text-[10px] text-fg-dim transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
          ▶
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${status === 'online' ? 'bg-ok' : status === 'offline' ? 'bg-danger' : 'bg-warn'}`} title={status} />
        <span className="font-medium">{machine?.name ?? 'sem máquina'}</span>
        <span className="ml-auto truncate text-xs text-fg-dim">
          {items.length} projeto{items.length === 1 ? '' : 's'} · {doing} em andamento · {openTasks} aberta{openTasks === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((i) => (
            <ProjectCard key={i.project.id} item={i} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Home: the active projects, one accordion per machine; all open until the user collapses one. */
export function ProjectsByMachine({ items, statuses }: { items: DashboardItem[]; statuses: Record<string, MachineStatus> }) {
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const groups = useMemo(() => groupByMachine(items, statuses), [items, statuses]);
  const keyOf = (g: ProjectGroup) => g.machine?.id ?? NO_MACHINE;
  const toggle = (g: ProjectGroup) => {
    const next = { ...open, [keyOf(g)]: !(open[keyOf(g)] ?? true) };
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the choice just does not persist */
    }
  };
  return (
    <ul className="space-y-4">
      {groups.map((g) => (
        <MachineSection key={keyOf(g)} group={g} status={g.machine ? (statuses[g.machine.id] ?? 'checking') : 'offline'} open={open[keyOf(g)] ?? true} onToggle={() => toggle(g)} />
      ))}
    </ul>
  );
}
