import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { canSeeSettings } from '../lib/settings-sections';
import { ANALYTICS_ENABLED } from '../lib/analytics';
import { openCookieBanner } from './AnalyticsGate';
import { useData, type MachineStatus } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { needsYouByProject } from '../lib/needs-you';
import { useProjectChat } from '../lib/project-chat';
import { STATUS_DOT, STATUS_LABEL } from '../lib/machine-status';
import type { Machine } from '../lib/types';
import { relativeTime } from '../lib/time';
import { MachineForm } from './MachineForm';
import { ProjectForm } from './ProjectForm';
import { ViewAsSwitch } from './ViewAsSwitch';

/** Tooltip for a machine row: connection info (host, or "agente" with no host) + os/capabilities + last-seen when offline. */
export function machineTitle(m: Machine, status: MachineStatus): string {
  const base = m.type === 'agent' ? (m.is_local ? 'este computador (agente)' : 'agente') : m.type === 'ssh' ? `${m.ssh_user ? m.ssh_user + '@' : ''}${m.host}:${m.ssh_port}` : 'servidor do termhub';
  let title = base;
  if (m.os) title += ` · ${m.os}`;
  if (m.capabilities.length) title += ` · ${m.capabilities.join(', ')}`;
  if (m.type === 'agent' && status === 'offline' && m.agent_last_seen_at) title += ` · visto ${relativeTime(m.agent_last_seen_at)}`;
  return title;
}

/** The small "vX.Y.Z" next to an agent machine; `outdated` turns it into the update hint (the card in the machine form does the update). */
export function agentVersionBadge(m: Machine): { text: string; title: string; outdated: boolean } | null {
  if (m.type !== 'agent' || !m.agent_version) return null;
  if (m.update_available) return { text: `v${m.agent_version} ↑`, title: 'Nova versão do agente disponível — abra a máquina para atualizar', outdated: true };
  return { text: `v${m.agent_version}`, title: `agente v${m.agent_version}`, outdated: false };
}

export function Sidebar({ onCollapse }: { onCollapse?: () => void }) {
  const { user, logout, can, viewAs } = useAuth();
  const { projects, machinesOf, hiddenLocal, claimLocal, statuses, missingTmux, loading, checkStatus } = useData();
  const { items: monitorItems, needsYou } = useMonitor();
  const waiting = useMemo(() => needsYouByProject(monitorItems), [monitorItems]);
  const projectChat = useProjectChat();
  const navigate = useNavigate();
  const [machineForm, setMachineForm] = useState<{ open: boolean; machine?: Machine | null }>({ open: false });
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});

  const visibleProjects = projects.filter((p) => showArchived || p.status !== 'archived');
  const hasArchived = projects.some((p) => p.status === 'archived');

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

        <p className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wide text-fg-dim">Projetos</p>
        {!loading && visibleProjects.length === 0 && (
          <button className="px-3 py-1 text-xs text-fg-dim hover:text-fg" onClick={() => setProjectFormOpen(true)}>
            + novo projeto
          </button>
        )}
        <ul>
          {visibleProjects.map((p) => {
            const projectMachines = machinesOf(p);
            const isExpanded = collapsedProjects[p.id] !== true;
            return (
              <li key={p.id} className="mb-0.5">
                <div className="group/p flex items-center rounded-r hover:bg-bg-3">
                  <button
                    type="button"
                    className="shrink-0 px-1.5 py-1 text-[9px] text-fg-dim hover:text-fg"
                    title={isExpanded ? 'Recolher' : 'Expandir'}
                    aria-label={isExpanded ? 'Recolher máquinas do projeto' : 'Expandir máquinas do projeto'}
                    aria-expanded={isExpanded}
                    onClick={() => setCollapsedProjects((c) => ({ ...c, [p.id]: isExpanded }))}
                  >
                    {isExpanded ? '▼' : '▶'}
                  </button>
                  <NavLink
                    to={`/projects/${p.id}`}
                    className={({ isActive }) =>
                      `flex min-w-0 flex-1 items-center gap-2 rounded-r py-1 pr-3 text-sm ${isActive ? 'bg-accent/15 text-fg' : 'text-fg-muted group-hover/p:text-fg'}`
                    }
                    title={projectMachines.map((m) => m.name).join(', ') || 'sem máquina vinculada'}
                  >
                    <span className="shrink-0 font-mono text-[10px] text-fg-dim">{p.key}</span>
                    <span className={`truncate ${p.status !== 'active' ? 'opacity-60' : ''}`}>{p.name}</span>
                    {!!waiting.get(p.id) && (
                      <span
                        className="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-attention"
                        title={waiting.get(p.id) === 1 ? '1 tab esperando você' : `${waiting.get(p.id)} tabs esperando você`}
                        aria-label="esperando você"
                      />
                    )}
                    {!!p.open_tasks && p.status === 'active' && (
                      <span className={`${waiting.get(p.id) ? '' : 'ml-auto '}rounded-full bg-bg-4 px-1.5 text-[10px] tabular-nums text-fg-muted group-hover/p:hidden`} title={`${p.open_tasks} task(s) aberta(s)`}>
                        {p.open_tasks}
                      </span>
                    )}
                    {p.status === 'paused' && <span className={`${waiting.get(p.id) ? '' : 'ml-auto '}text-[10px] text-warn group-hover/p:hidden`}>pausado</span>}
                    {p.status === 'archived' && <span className={`${waiting.get(p.id) ? '' : 'ml-auto '}text-[10px] text-fg-dim group-hover/p:hidden`}>arquivado</span>}
                  </NavLink>
                  {/* ações: ficam fora do link para não navegar ao clicar. O 💬 fica visível sem hover
                      enquanto o chat do projeto responde ou espera uma confirmação sua. */}
                  {(() => {
                    const chatStatus = projectChat.status(p.id);
                    const chatActive = chatStatus.busy || chatStatus.pending > 0;
                    return (
                      <span className="flex shrink-0 items-center gap-0.5 pr-1">
                        {can('chat') && (
                          <button
                            type="button"
                            data-active={chatActive}
                            className={`relative rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg ${chatActive || projectChat.openProjectId === p.id ? '' : 'hidden group-hover/p:inline-block'}`}
                            aria-label="Chat do projeto"
                            title={chatStatus.pending > 0 ? 'Chat do projeto — esperando sua confirmação' : chatStatus.busy ? 'Chat do projeto — respondendo' : 'Chat do projeto'}
                            onClick={() => projectChat.toggle(p.id)}
                          >
                            💬
                            {chatActive && <span className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${chatStatus.pending > 0 ? 'bg-attention' : 'animate-pulse bg-accent'}`} />}
                          </button>
                        )}
                        <button className="hidden rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg group-hover/p:inline-block" title="Editar projeto" onClick={() => navigate(`/projects/${p.id}/settings`)}>
                          ✎
                        </button>
                      </span>
                    );
                  })()}
                </div>
                {isExpanded && (
                  <ul className="ml-4 border-l border-line pl-2">
                    {projectMachines.length === 0 ? (
                      <li>
                        <NavLink to={`/projects/${p.id}/settings`} className="block px-2 py-1 text-[11px] text-fg-dim hover:text-fg">
                          sem máquina · vincular
                        </NavLink>
                      </li>
                    ) : (
                      projectMachines.map((m) => {
                        const status = statuses[m.id] ?? 'checking';
                        return (
                          <li key={m.id} className="group flex items-center gap-1.5 px-1 py-1 text-xs">
                            <span
                              className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                              title={`${STATUS_LABEL[status]} — clique para verificar`}
                              onClick={() => void checkStatus(m.id)}
                            />
                            <span className="truncate" title={machineTitle(m, status)}>
                              {m.name}
                            </span>
                            {m.is_local && (
                              <span className="text-[10px] text-fg-dim" title="O computador que você está usando; aparece só neste navegador">
                                este pc
                              </span>
                            )}
                            {m.os && <span className="text-[10px] text-fg-dim">{m.os === 'macos' ? '' : m.os}</span>}
                            {(() => {
                              const badge = agentVersionBadge(m);
                              if (!badge) return null;
                              return badge.outdated ? (
                                <button type="button" className="rounded px-1 text-[10px] text-warn hover:bg-bg-3" title={badge.title} onClick={() => setMachineForm({ open: true, machine: m })}>
                                  {badge.text}
                                </button>
                              ) : (
                                <span className="text-[10px] text-fg-dim" title={badge.title}>
                                  {badge.text}
                                </span>
                              );
                            })()}
                            {viewAs === 'all' && (
                              <span className="truncate text-[10px] text-fg-dim" title={m.owner_name ? `Dono: ${m.owner_name}` : 'Sem dono'}>
                                {m.owner_name ?? 'sem dono'}
                              </span>
                            )}
                            {missingTmux[m.id] && (
                              <span className="text-[10px] text-warn" title="tmux não está instalado nesta máquina">
                                sem tmux
                              </span>
                            )}
                            {m.type === 'agent' && m.hooks_installed_at === null && (
                              <button
                                type="button"
                                className="rounded px-1 text-[10px] text-warn hover:bg-bg-3"
                                title="Os hooks do monitor não estão instalados: as tabs desta máquina não aparecem em “Precisando de você”. Clique para instalar."
                                onClick={() => setMachineForm({ open: true, machine: m })}
                              >
                                sem monitor
                              </button>
                            )}
                            <span className="ml-auto hidden items-center gap-0.5 group-hover:flex">
                              <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title="Editar" onClick={() => setMachineForm({ open: true, machine: m })}>
                                ✎
                              </button>
                            </span>
                          </li>
                        );
                      })
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        {hiddenLocal.length > 0 && (
          <div className="mt-2 px-3 text-xs text-fg-dim">
            <p title="Máquinas marcadas como “o computador que estou usando” em outro navegador. Se esta for a máquina onde você está, clique para vê-la aqui.">
              {hiddenLocal.length === 1 ? '1 máquina local de outro computador' : `${hiddenLocal.length} máquinas locais de outros computadores`}
            </p>
            <ul className="mt-0.5">
              {hiddenLocal.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <span className="truncate">{m.name}</span>
                  <button className="hover:text-fg" title="Mostrar neste navegador (é o computador que estou usando)" onClick={() => claimLocal(m.id)}>
                    é este pc
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {hasArchived && (
          <button className="mt-2 px-3 text-xs text-fg-dim hover:text-fg" onClick={() => setShowArchived((v) => !v)}>
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

      {machineForm.open && (
        <MachineForm key={machineForm.machine?.id ?? 'new'} open onClose={() => setMachineForm({ open: false })} machine={machineForm.machine} />
      )}
      {projectFormOpen && <ProjectForm open onClose={() => setProjectFormOpen(false)} />}
    </aside>
  );
}
