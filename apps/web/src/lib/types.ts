export type MachineType = 'local' | 'ssh';
export type ProjectStatus = 'active' | 'paused' | 'archived';

export interface RoleInfo {
  id: string;
  name: string;
  label: string;
  is_admin: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  /** legacy flag; use role_info */
  role: 'owner' | 'member';
  role_info: RoleInfo | null;
  /** "resource:action" grants (admins get the whole catalog) */
  permissions: string[];
  has_password: boolean;
  has_google: boolean;
  /** set when the user was created by an invite */
  invited_at: string | null;
  /** last successful sign-in; null = never (invite pending) */
  last_login_at: string | null;
}

/** Side effects of an invite (the user row is created regardless). */
export interface InviteResult {
  user: User;
  access: { configured: boolean; synced: boolean; error?: string };
  mail: { sent: boolean; error?: string };
}

/** Cloudflare Access allowlist as the server sees it. */
export interface AccessStatus {
  configured: boolean;
  domain?: string;
  policy?: string;
  emails: string[];
  error?: string;
}

export interface Role extends RoleInfo {
  description: string | null;
  is_system: boolean;
  created_at: string;
  users?: number;
}

export type PermissionAction = 'create' | 'read' | 'update' | 'delete';
export interface ResourcePermissions {
  resource: string;
  label: string;
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
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
  /** null = orphan (visible only to admins viewing "all") */
  owner_id: string | null;
  owner_name: string | null;
  created_at: string;
}

/** Admin data-scope switch: null = own data, "all" = everything, or the impersonated user. */
export type ViewAs = null | 'all' | { id: string; name: string; email: string; avatar_url: string | null };

export interface FsRoot {
  kind: 'home' | 'disk';
  label: string;
  path: string;
  source?: string;
  size_kb?: number;
  avail_kb?: number;
}

export interface FsEntry {
  name: string;
  path: string;
}

/** Resposta de GET /machines/:id/fs */
export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  roots: FsRoot[];
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

/** Corpo de criação/edição de projeto. `create_dir`: cria a pasta na máquina se não existir. */
export type ProjectInput = Partial<Project> & { create_dir?: boolean };

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
  owner_id: string | null;
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

export type TabKind = 'terminal' | 'simulator';

export interface Tab {
  id: string;
  project_id: string;
  name: string;
  kind: TabKind;
  tmux_session: string | null;
  simulator_udid: string | null;
  position: number;
  /** monitor: what the tool in the tab is doing (from its hooks); null = never reported */
  state: TabState | null;
  /** the tool's pending question / notification */
  state_text: string | null;
  state_tool: string | null;
  state_at: string | null;
  created_at: string;
  alive: boolean;
}

export type TabState = 'working' | 'waiting_input' | 'waiting_permission' | 'idle' | 'error';

export const TAB_STATE_LABEL: Record<TabState, string> = {
  working: 'trabalhando',
  waiting_input: 'esperando resposta',
  waiting_permission: 'pedindo permissão',
  idle: 'terminou',
  error: 'erro',
};

/** States in which the tool is waiting for the person. */
export const NEEDS_YOU: readonly TabState[] = ['waiting_input', 'waiting_permission'];

export interface TabEvent {
  id: string;
  tab_id: string;
  kind: TabState;
  tool: string;
  text: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface MonitorItem {
  tab: Tab;
  project: Project;
  machine: Machine;
}

export interface Transcription {
  id: string;
  status: 'pending' | 'done' | 'error';
  text?: string;
  /** audio length in seconds */
  duration?: number;
  error?: string;
}

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

export interface WdaSetupState {
  state: 'idle' | 'running' | 'ok' | 'failed';
  tail: string[];
  version: string | null;
}

export interface Screen {
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
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

export type AiProvider = 'claude' | 'chatgpt' | 'gemini' | 'antigravity';

export interface AiAccount {
  id: string;
  provider: AiProvider;
  label: string;
  machine_id: string;
  config_dir: string | null;
  created_at: string;
}

export interface AiUsageWindow {
  key: string;
  label: string;
  /** 0..100 */
  utilization: number;
  resets_at: string | null;
}

export interface AiAccountUsage {
  account_id: string;
  fetched_at: string;
  ok: boolean;
  plan: string | null;
  windows: AiUsageWindow[];
  error: string | null;
  hint: string | null;
  /** last good reading, shown because the provider is rate-limiting the usage query */
  stale?: boolean;
}

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', antigravity: 'Antigravity' };

export type SshProblem = 'unreachable' | 'refused' | 'auth' | 'hostkey' | 'timeout' | 'no_tmux' | 'unknown';

/** Result of POST /machines/test */
export interface SshDiagnosis {
  ok: boolean;
  connected: boolean;
  tmux: boolean;
  os: string | null;
  problem: SshProblem | null;
  hint: string | null;
  detail: string | null;
}

/** GET /machines/:id/hardware */
export interface HardwareSnapshot {
  os: string | null;
  hostname: string | null;
  cpu_model: string | null;
  ncpu: number | null;
  uptime_s: number | null;
  load: [number, number, number] | null;
  cpu_pct: number | null;
  mem_total_kb: number | null;
  mem_used_kb: number | null;
  swap_total_kb: number | null;
  swap_used_kb: number | null;
  disks: { mount: string; source: string; size_kb: number; used_kb: number; avail_kb: number }[];
  temps: { label: string; c: number }[];
  gpus: { name: string; utilization: number | null; mem_used_mb: number | null; mem_total_mb: number | null; temp_c: number | null }[];
  processes: { cpu: number; mem: number; command: string }[];
  collected_at: string;
}

/** Cloud waitlist sign-up (GET /waitlist) */
export interface WaitlistEntry {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_country: string;
  phone_area: string;
  phone_number: string;
  phone: string;
  linkedin: string | null;
  github: string | null;
  locale: string;
  source: string;
  created_at: string;
}
