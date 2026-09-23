import type { MachineStatus } from './data';
import type { MachineType } from './types';

/** Shared status-dot styling/labels for a machine's online/offline/checking state (sidebar, Máquinas page, project walkthrough). */
export const STATUS_DOT: Record<MachineStatus, string> = {
  checking: 'bg-warn animate-pulse',
  online: 'bg-ok',
  offline: 'bg-danger',
};

export const STATUS_LABEL: Record<MachineStatus, string> = { checking: 'verificando', online: 'online', offline: 'offline' };

/** Legacy transports (kept for machines that already exist; new machines are agent-only). */
export const TYPE_LABEL: Record<MachineType, string> = { agent: 'Agente', ssh: 'SSH (legado)', local: 'Servidor do termhub (legado)' };
