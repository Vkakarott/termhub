import type { MachineStatus } from './data';
import type { Machine } from './types';
import { relativeTime } from './time';

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
