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
  os: string | null;
  capabilities: string[];
  checked_at: string | null;
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
  /** tasks em "todo" + "doing" (vem na listagem) */
  open_tasks?: number;
}

export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  position: number;
  external_ref: ExternalRef | null;
  external_key: string | null;
  tab_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Ticket {
  id: string;
  project_id: string;
  integration_id: string;
  provider: IntegrationProvider;
  external_key: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: string;
  status: TaskStatus;
  meta: Record<string, unknown> & { labels?: string[]; assignee?: string | null; priority?: unknown; updated_at?: string };
  task_id: string | null;
  synced_at: string;
  created_at: string;
}

export interface ExternalRef {
  provider: IntegrationProvider;
  id: string;
  identifier: string;
  url: string;
  state: string;
  status: TaskStatus;
  scope?: string;
  pushed_at?: string;
  updated_at?: string;
  priority?: unknown;
  assignee?: string | null;
  labels?: string[];
}

export type IntegrationProvider = 'github' | 'linear' | 'jira';

export interface Integration {
  id: string;
  provider: IntegrationProvider;
  name: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ConnectionInfo {
  ok: boolean;
  account?: string;
  options?: Record<string, { id: string; name: string }[]>;
  error?: string;
}

export type DecisionMode = 'ask' | 'auto';

export interface ProjectSetupData {
  repo: {
    integration_id: string | null;
    full_name: string | null;
    base_branch: string;
    branch_pattern: string;
    draft_pr: boolean;
  } | null;
  tickets: {
    provider: IntegrationProvider;
    integration_id: string;
    scope: string;
    filter: string | null;
    include_done: boolean;
    sync_minutes: number;
  } | null;
  runner: { machine_id: string | null; cwd: string | null; setup_command: string | null; worktree: boolean };
  agent: { command: string; plugins: string[]; model: string | null; extra_args: string | null };
  verify: { type: 'none' | 'ios-simulator' | 'web-screenshot' | 'command'; target: string | null; build_command: string | null };
  approvals: Record<'spec' | 'plan' | 'pr' | 'merge' | 'tool_permissions' | 'questions', DecisionMode>;
}

export interface ProjectSetup {
  project_id: string;
  version: number;
  data: ProjectSetupData;
  updated_at: string | null;
}

export const PROVIDER_LABEL: Record<IntegrationProvider, string> = { github: 'GitHub', linear: 'Linear', jira: 'Jira' };

export const APPROVAL_LABEL: Record<keyof ProjectSetupData['approvals'], { label: string; hint: string }> = {
  spec: { label: 'Aprovar a spec', hint: 'antes de o agente planejar' },
  plan: { label: 'Aprovar o plano', hint: 'antes de implementar' },
  pr: { label: 'Aprovar o PR', hint: 'com o screenshot/evidência' },
  merge: { label: 'Fazer o merge', hint: 'após o PR aprovado' },
  tool_permissions: { label: 'Permissões de ferramentas', hint: 'pedidos do Claude para rodar comandos/editar' },
  questions: { label: 'Perguntas do agente', hint: 'dúvidas em aberto durante a run' },
};

export interface Note {
  id: string;
  project_id: string;
  content: string;
  updated_at: string;
}

export interface DashboardItem {
  project: Project;
  machine: Machine | null;
  doing: Task[];
  open_tasks: number;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'A fazer',
  doing: 'Fazendo',
  done: 'Feito',
};

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
