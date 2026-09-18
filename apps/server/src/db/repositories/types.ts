import type {
  User as PrismaUser,
  Session as PrismaSession,
  Machine as PrismaMachine,
  Project as PrismaProject,
  Tab as PrismaTab,
  Task as PrismaTask,
  Note as PrismaNote,
  Ticket as PrismaTicket,
} from '../../generated/prisma/client.js';

export type UserRole = 'owner' | 'member';
export type MachineType = 'local' | 'ssh';
export type ProjectStatus = 'active' | 'paused' | 'archived';
export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'done';
export type TabKind = 'terminal' | 'simulator';

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
  /** DEPRECATED legacy flag; use role_id */
  role: UserRole;
  role_id: string | null;
  /** set when the user was created by an invite */
  invited_at: string | null;
  /** last successful sign-in; null = never signed in */
  last_login_at: string | null;
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
  os: string | null;
  capabilities: string[];
  checked_at: string | null;
  /** null = orphan (only visible to admins viewing "all") */
  owner_id: string | null;
  /** owner's display name (list/detail convenience for the "all" view) */
  owner_name: string | null;
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
  kind: TabKind;
  tmux_session: string | null;
  simulator_udid: string | null;
  position: number;
  created_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  position: number;
  /** Ticket externo: { provider, id, identifier, url, state, meta } */
  external_ref: unknown | null;
  external_key: string | null;
  tab_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Ticket {
  id: string;
  project_id: string;
  integration_id: string;
  provider: 'github' | 'linear' | 'jira';
  external_key: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: string;
  status: TaskStatus;
  meta: Record<string, unknown>;
  task_id: string | null;
  synced_at: string;
  created_at: string;
}

export interface Note {
  id: string;
  project_id: string;
  content: string;
  updated_at: string;
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
  role_id: u.roleId,
  invited_at: u.invitedAt?.toISOString() ?? null,
  last_login_at: u.lastLoginAt?.toISOString() ?? null,
  created_at: u.createdAt.toISOString(),
});

export const mapSession = (s: PrismaSession): Session => ({
  id: s.id,
  user_id: s.userId,
  token_hash: s.tokenHash,
  expires_at: s.expiresAt.toISOString(),
  created_at: s.createdAt.toISOString(),
});

export const mapMachine = (m: PrismaMachine & { owner?: { name: string } | null }): Machine => ({
  id: m.id,
  name: m.name,
  host: m.host,
  ssh_user: m.sshUser,
  ssh_port: m.sshPort,
  type: m.type,
  os: m.os,
  capabilities: Array.isArray(m.capabilities) ? (m.capabilities as string[]) : [],
  checked_at: iso(m.checkedAt),
  owner_id: m.ownerId,
  owner_name: m.owner?.name ?? null,
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
  kind: t.kind,
  tmux_session: t.tmuxSession,
  simulator_udid: t.simulatorUdid,
  position: t.position,
  created_at: t.createdAt.toISOString(),
});

export const mapTask = (t: PrismaTask): Task => ({
  id: t.id,
  project_id: t.projectId,
  title: t.title,
  description: t.description,
  status: t.status,
  position: t.position,
  external_ref: t.externalRef ?? null,
  external_key: t.externalKey,
  tab_id: t.tabId,
  created_at: t.createdAt.toISOString(),
  updated_at: t.updatedAt.toISOString(),
});

export const mapTicket = (t: PrismaTicket): Ticket => ({
  id: t.id,
  project_id: t.projectId,
  integration_id: t.integrationId,
  provider: t.provider,
  external_key: t.externalKey,
  identifier: t.identifier,
  title: t.title,
  description: t.description,
  url: t.url,
  state: t.state,
  status: t.status,
  meta: (t.meta ?? {}) as Record<string, unknown>,
  task_id: t.taskId,
  synced_at: t.syncedAt.toISOString(),
  created_at: t.createdAt.toISOString(),
});

export const mapNote = (n: PrismaNote): Note => ({
  id: n.id,
  project_id: n.projectId,
  content: n.content,
  updated_at: n.updatedAt.toISOString(),
});

/** Remove campos sensíveis antes de enviar ao cliente. */
export type PublicUser = Omit<User, 'password_hash' | 'google_id'> & { has_password: boolean; has_google: boolean };

export function toPublicUser(u: User): PublicUser {
  const { password_hash, google_id, ...rest } = u;
  return { ...rest, has_password: !!password_hash, has_google: !!google_id };
}

export type AiProvider = 'claude' | 'chatgpt' | 'gemini' | 'antigravity';

export interface AiAccount {
  id: string;
  provider: AiProvider;
  label: string;
  machine_id: string;
  config_dir: string | null;
  created_at: string;
}

export function mapAiAccount(a: { id: string; provider: AiProvider; label: string; machineId: string; configDir: string | null; createdAt: Date }): AiAccount {
  return { id: a.id, provider: a.provider, label: a.label, machine_id: a.machineId, config_dir: a.configDir, created_at: a.createdAt.toISOString() };
}
