import type {
  User as PrismaUser,
  Session as PrismaSession,
  Machine as PrismaMachine,
  Project as PrismaProject,
  Tab as PrismaTab,
} from '../../generated/prisma/client.js';

export type UserRole = 'owner' | 'member';
export type MachineType = 'local' | 'ssh';
export type ProjectStatus = 'active' | 'paused' | 'archived';

/**
 * Tipos expostos pela camada de dados (snake_case, datas em ISO string).
 * O restante do app nunca importa o Prisma diretamente.
 */
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

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const mapUser = (u: PrismaUser): User => ({
  id: u.id,
  email: u.email,
  name: u.name,
  avatar_url: u.avatarUrl,
  password_hash: u.passwordHash,
  google_id: u.googleId,
  role: u.role,
  created_at: u.createdAt.toISOString(),
});

export const mapSession = (s: PrismaSession): Session => ({
  id: s.id,
  user_id: s.userId,
  token_hash: s.tokenHash,
  expires_at: s.expiresAt.toISOString(),
  created_at: s.createdAt.toISOString(),
});

export const mapMachine = (m: PrismaMachine): Machine => ({
  id: m.id,
  name: m.name,
  host: m.host,
  ssh_user: m.sshUser,
  ssh_port: m.sshPort,
  type: m.type,
  created_at: m.createdAt.toISOString(),
});

export const mapProject = (p: PrismaProject): Project => ({
  id: p.id,
  machine_id: p.machineId,
  name: p.name,
  cwd: p.cwd,
  status: p.status,
  description: p.description,
  last_terminal_at: iso(p.lastTerminalAt),
  created_at: p.createdAt.toISOString(),
});

export const mapTab = (t: PrismaTab): Tab => ({
  id: t.id,
  project_id: t.projectId,
  name: t.name,
  tmux_session: t.tmuxSession,
  position: t.position,
  created_at: t.createdAt.toISOString(),
});

/** Remove campos sensíveis antes de enviar ao cliente. */
export type PublicUser = Omit<User, 'password_hash' | 'google_id'> & { has_password: boolean; has_google: boolean };

export function toPublicUser(u: User): PublicUser {
  const { password_hash, google_id, ...rest } = u;
  return { ...rest, has_password: !!password_hash, has_google: !!google_id };
}
