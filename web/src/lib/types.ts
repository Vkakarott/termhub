export type MachineType = 'local' | 'ssh';
export type ProjectStatus = 'active' | 'paused' | 'archived';

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: 'owner' | 'member';
  has_password: boolean;
  has_google: boolean;
}

export interface Machine {
  id: string;
  name: string;
  host: string | null;
  ssh_user: string | null;
  ssh_port: number;
  type: MachineType;
  created_at: string;
}

export interface Project {
  id: string;
  machine_id: string;
  name: string;
  cwd: string;
  status: ProjectStatus;
  description: string | null;
  last_terminal_at: string | null;
  created_at: string;
}

export interface Tab {
  id: string;
  project_id: string;
  name: string;
  tmux_session: string;
  position: number;
  created_at: string;
  alive: boolean;
}

export interface AuthConfig {
  modes: ('app' | 'cloudflare' | 'disabled')[];
  google: boolean;
  password: boolean;
  email_code: boolean;
}

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Ativo',
  paused: 'Pausado',
  archived: 'Arquivado',
};
