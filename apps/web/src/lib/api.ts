import type { AccessStatus, ApiToken, ApiTokenScope, CreatedApiToken, InviteResult, ViewAs, PermissionAction, ResourcePermissions, Role, WaitlistEntry, HardwareSnapshot, AiAccount, AiAccountUsage, AiProvider, AuthConfig, ConnectionInfo, DashboardItem, FsListing, Integration, IntegrationProvider, Machine, MachineHooks, MonitorItem, Note, Project, ProjectInput, ProjectSetup, ProjectSetupData, Simulator, Tab, TabEvent, TabKind, Task, Transcription, TaskStatus, UploadEntry, UploadMachineStatus, Ticket, User, WdaSetupState, WaitlistInviteResult } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public issues?: unknown,
  ) {
    super(message);
  }
}

export function readCookie(name: string): string | undefined {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const raw = body instanceof Blob;
  if (raw) headers['content-type'] = body.type || 'application/octet-stream';
  else if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie('termhub_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw errorFrom(res.status, data);
  return data as T;
}

function errorFrom(status: number, data: unknown): ApiError {
  const d = (data ?? {}) as { error?: string; code?: string; issues?: unknown };
  if (status === 401) window.dispatchEvent(new CustomEvent('termhub:unauthorized'));
  return new ApiError(status, d.error ?? `Erro ${status}`, d.code, d.issues);
}

/**
 * POST of a binary body with upload progress (fetch has none): used for dictation clips, whose upload
 * on a slow uplink is long enough to deserve a percentage. Same cookies/CSRF/error shape as request().
 */
function upload<T>(path: string, body: Blob, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', body.type || 'application/octet-stream');
    const csrf = readCookie('termhub_csrf');
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'Sem conexão com o servidor', 'NETWORK'));
    xhr.onabort = () => reject(new ApiError(0, 'Envio cancelado', 'ABORTED'));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(errorFrom(xhr.status, data));
    };
    xhr.send(body);
  });
}

export const api = {
  auth: {
    config: () => request<AuthConfig>('GET', '/auth/config'),
    me: () => request<{ user: User; view_as: ViewAs }>('GET', '/auth/me'),
    /** admin only: null = self, '*' = everything, or a user id */
    viewAs: (user_id: string | null) => request<{ view_as: ViewAs }>('POST', '/auth/view-as', { user_id }),
    login: (email: string, password: string) => request<{ user: User }>('POST', '/auth/login', { email, password }),
    sendCode: (email: string) => request<{ ok: true; ttl_minutes: number }>('POST', '/auth/code/send', { email }),
    verifyCode: (email: string, code: string) => request<{ user: User }>('POST', '/auth/code/verify', { email, code }),
    logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  },
  machines: {
    list: () => request<{ machines: Machine[] }>('GET', '/machines'),
    /** for `type: 'agent'`, the response also carries `agent_token` (the plaintext token, shown only once) */
    create: (input: Partial<Machine>) => request<{ machine: Machine; agent_token?: string }>('POST', '/machines', input),
    update: (id: string, input: Partial<Machine>) => request<{ machine: Machine }>('PATCH', `/machines/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/machines/${id}`),
    status: (id: string) =>
      request<{ id: string; online: boolean; tmux: boolean; os: string | null; capabilities: string[]; agent_version?: string | null; last_seen_at?: string | null }>(
        'GET',
        `/machines/${id}/status`,
      ),
    /** issues a new agent token, invalidating the previous one */
    rotateAgentToken: (id: string) => request<{ agent_token: string }>('POST', `/machines/${id}/agent-token`, {}),
    simulators: (id: string) => request<{ simulators: Simulator[] }>('GET', `/machines/${id}/simulators`),
    wdaSetup: (id: string) => request<WdaSetupState>('GET', `/machines/${id}/simulator/setup`),
    hooks: (id: string) => request<MachineHooks>('GET', `/machines/${id}/hooks`),
    installHooks: (id: string) => request<MachineHooks & { claude: 'installed' | 'skipped'; codex: 'installed' | 'skipped'; claude_dirs?: string[] }>('POST', `/machines/${id}/hooks`),
    removeHooks: (id: string) => request<{ ok: true }>('DELETE', `/machines/${id}/hooks`),
    startWdaSetup: (id: string) => request<{ ok: true }>('POST', `/machines/${id}/simulator/setup`, {}),
    /** subpastas de `path` (padrão $HOME) + discos/mounts da máquina */
    hardware: (id: string) => request<{ hardware: HardwareSnapshot }>('GET', `/machines/${id}/hardware`),
    mkdir: (id: string, parent: string, name: string) => request<{ path: string }>('POST', `/machines/${id}/fs/mkdir`, { parent, name }),
    browse: (id: string, path?: string) => request<FsListing>('GET', `/machines/${id}/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  },
  projects: {
    list: () => request<{ projects: Project[] }>('GET', '/projects'),
    get: (id: string) => request<{ project: Project }>('GET', `/projects/${id}`),
    create: (input: ProjectInput) => request<{ project: Project }>('POST', '/projects', input),
    update: (id: string, input: ProjectInput) => request<{ project: Project }>('PATCH', `/projects/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/projects/${id}`),
    tabs: (id: string) => request<{ reachable: boolean; tabs: Tab[] }>('GET', `/projects/${id}/tabs`),
    createTab: (id: string, input: { name?: string; kind?: TabKind; simulator_udid?: string } = {}) =>
      request<{ tab: Tab }>('POST', `/projects/${id}/tabs`, input),
  },
  dashboard: () => request<{ items: DashboardItem[] }>('GET', '/dashboard'),
  monitor: {
    tabs: () => request<{ items: MonitorItem[] }>('GET', '/monitor/tabs'),
  },
  tasks: {
    list: (projectId: string) => request<{ tasks: Task[] }>('GET', `/projects/${projectId}/tasks`),
    create: (projectId: string, input: { title: string; description?: string | null; status?: TaskStatus; parent_id?: string | null }) =>
      request<{ task: Task }>('POST', `/projects/${projectId}/tasks`, input),
    update: (id: string, input: { title?: string; description?: string | null; status?: TaskStatus }) =>
      request<{ task: Task }>('PATCH', `/tasks/${id}`, input),
    move: (id: string, status: TaskStatus, position: number) => request<{ task: Task }>('POST', `/tasks/${id}/move`, { status, position }),
    remove: (id: string) => request<{ ok: true; deleted_subtasks: number }>('DELETE', `/tasks/${id}`),
    addSubtasks: (id: string, items: { title: string; description?: string | null }[]) =>
      request<{ subtasks: Task[] }>('POST', `/tasks/${id}/subtasks`, { items }),
    reorder: (id: string, position: number) => request<{ task: Task }>('POST', `/tasks/${id}/reorder`, { position }),
    pushStatus: (id: string) => request<{ task: Task; state: string }>('POST', `/tasks/${id}/push-status`, {}),
    openTerminal: (id: string) => request<{ task: Task; tab: Tab; created: boolean }>('POST', `/tasks/${id}/terminal`, {}),
    detachTerminal: (id: string) => request<{ task: Task }>('DELETE', `/tasks/${id}/terminal`),
  },
  tickets: {
    list: (projectId: string) => request<{ tickets: Ticket[] }>('GET', `/projects/${projectId}/tickets`),
    import: (projectId: string, ticketIds: string[]) => request<{ tasks: Task[] }>('POST', `/projects/${projectId}/tickets/import`, { ticket_ids: ticketIds }),
  },
  notes: {
    get: (projectId: string) => request<{ note: Note }>('GET', `/projects/${projectId}/note`),
    save: (projectId: string, content: string) => request<{ note: Note }>('PUT', `/projects/${projectId}/note`, { content }),
  },
  integrations: {
    list: () => request<{ integrations: Integration[] }>('GET', '/integrations'),
    create: (input: { provider: IntegrationProvider; name: string; config: Record<string, unknown>; secret: string }) =>
      request<{ integration: Integration }>('POST', '/integrations', input),
    update: (id: string, input: { name?: string; config?: Record<string, unknown>; secret?: string }) =>
      request<{ integration: Integration }>('PATCH', `/integrations/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/integrations/${id}`),
    test: (input: { provider: IntegrationProvider; config: Record<string, unknown>; secret?: string; integration_id?: string }) =>
      request<ConnectionInfo>('POST', '/integrations/test', input),
  },
  setup: {
    get: (projectId: string) => request<{ setup: ProjectSetup }>('GET', `/projects/${projectId}/setup`),
    save: (projectId: string, data: ProjectSetupData) => request<{ setup: ProjectSetup }>('PUT', `/projects/${projectId}/setup`, data),
    syncTickets: (projectId: string) =>
      request<{ ok: true; fetched: number; created: number; updated: number; removed: number; synced_at: string }>('POST', `/projects/${projectId}/tickets/sync`, {}),
  },
  aiAccounts: {
    list: () => request<{ accounts: AiAccount[] }>('GET', '/ai-accounts'),
    create: (input: { provider: AiProvider; label: string; machine_id: string; config_dir?: string | null }) =>
      request<{ account: AiAccount }>('POST', '/ai-accounts', input),
    update: (id: string, input: { label?: string; machine_id?: string; config_dir?: string | null }) => request<{ account: AiAccount }>('PATCH', `/ai-accounts/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/ai-accounts/${id}`),
    usage: (refresh = false) => request<{ usage: AiAccountUsage[] }>('GET', `/ai-accounts/usage${refresh ? '?refresh=1' : ''}`),
    usageOf: (id: string, refresh = false) => request<{ usage: AiAccountUsage }>('GET', `/ai-accounts/${id}/usage${refresh ? '?refresh=1' : ''}`),
  },
  roles: {
    list: () => request<{ roles: Role[] }>('GET', '/roles'),
    resources: () => request<{ resources: { key: string; label: string }[]; actions: PermissionAction[] }>('GET', '/roles/resources'),
    create: (input: { name: string; label: string; description?: string | null; is_admin?: boolean }) => request<{ role: Role }>('POST', '/roles', input),
    update: (id: string, input: { label?: string; description?: string | null; is_admin?: boolean }) => request<{ role: Role }>('PATCH', `/roles/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/roles/${id}`),
    permissions: (id: string) => request<{ role: Role; permissions: ResourcePermissions[] }>('GET', `/roles/${id}/permissions`),
    toggle: (id: string, resource: string, action: PermissionAction) => request<{ granted: boolean }>('POST', `/roles/${id}/permissions/toggle`, { resource, action }),
  },
  users: {
    list: () => request<{ users: User[] }>('GET', '/users'),
    access: () => request<AccessStatus>('GET', '/users/access'),
    invite: (input: { email: string; name?: string; role_id: string }) => request<InviteResult>('POST', '/users/invite', input),
    resendInvite: (id: string) => request<InviteResult>('POST', `/users/${id}/invite`),
    inviteFromWaitlist: (input: { ids: string[]; role_id: string }) => request<{ results: WaitlistInviteResult[] }>('POST', '/users/invite-from-waitlist', input),
    setRole: (id: string, role_id: string) => request<{ user: User }>('PATCH', `/users/${id}`, { role_id }),
    remove: (id: string) => request<{ ok: true; access_removed: boolean }>('DELETE', `/users/${id}`),
  },
  apiTokens: {
    list: () => request<{ tokens: ApiToken[] }>('GET', '/api-tokens'),
    create: (input: { name: string; scopes: ApiTokenScope[]; expires_in_days: number | null }) => request<CreatedApiToken>('POST', '/api-tokens', input),
    revoke: (id: string) => request<{ api_token: ApiToken }>('DELETE', `/api-tokens/${id}`),
  },
  waitlist: {
    list: () => request<{ entries: WaitlistEntry[] }>('GET', '/waitlist'),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/waitlist/${id}`),
  },
  tabs: {
    rename: (id: string, name: string) => request<{ tab: Tab }>('PATCH', `/tabs/${id}`, { name }),
    remove: (id: string) => request<{ ok: true; killed: boolean }>('DELETE', `/tabs/${id}`),
    update: (id: string, input: { name?: string; simulator_udid?: string | null }) => request<{ tab: Tab }>('PATCH', `/tabs/${id}`, input),
    screenshotUrl: (id: string) => `/api/tabs/${id}/simulator/screenshot`,
    /** types text into the tab's tmux session (and presses Enter) — no terminal attached needed */
    input: (id: string, text: string, enter = true) => request<{ ok: true; tab: Tab }>('POST', `/tabs/${id}/input`, { text, enter }),
    events: (id: string, limit = 50) => request<{ events: TabEvent[] }>('GET', `/tabs/${id}/events?limit=${limit}`),
    /** writes the file to ~/.cache/termhub/paste/ on the tab's machine and returns its path */
    pasteFile: (id: string, file: Blob, name?: string) =>
      request<{ path: string; bytes: number; mime: string }>('POST', `/tabs/${id}/paste-file${name ? `?name=${encodeURIComponent(name)}` : ''}`, new Blob([file], { type: 'application/octet-stream' })),
  },
  uploads: {
    list: () => request<{ machines: UploadMachineStatus[]; files: UploadEntry[] }>('GET', '/uploads'),
    remove: (machineId: string, name: string) => request<{ ok: true; existed: boolean }>('DELETE', `/uploads/${machineId}/${encodeURIComponent(name)}`),
  },
  transcriptions: {
    config: () => request<{ enabled: boolean }>('GET', '/transcriptions/config'),
    /**
     * The blob keeps its recorder mime type (audio/webm, audio/mp4...) so the server can decode it;
     * `seconds` is the recorded length, which the server turns into a time estimate.
     */
    create: (audio: Blob, seconds: number, onProgress?: (fraction: number) => void) =>
      upload<{ transcription: Transcription }>(`/transcriptions?seconds=${Math.round(seconds)}`, audio, onProgress),
    get: (id: string) => request<{ transcription: Transcription }>('GET', `/transcriptions/${id}`),
  },
};
