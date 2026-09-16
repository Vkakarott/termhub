export type UserRole = 'owner' | 'member';
export type MachineType = 'local' | 'ssh';
export type ProjectStatus = 'active' | 'paused' | 'archived';

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  password_hash: string | null;
  google_id: string | null;
  role: UserRole;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
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
}

/** Remove campos sensíveis antes de enviar ao cliente. */
export type PublicUser = Omit<User, 'password_hash' | 'google_id'> & { has_password: boolean; has_google: boolean };

export function toPublicUser(u: User): PublicUser {
  const { password_hash, google_id, ...rest } = u;
  return { ...rest, has_password: !!password_hash, has_google: !!google_id };
}
