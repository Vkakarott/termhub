import type { AiAccount, AiAccountUsage, AiProvider, AuthConfig, ConnectionInfo, DashboardItem, FsListing, Integration, IntegrationProvider, Machine, Note, Project, ProjectInput, ProjectSetup, ProjectSetupData, Simulator, Tab, TabKind, Task, TaskStatus, Ticket, User, WdaSetupState } from './types';

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

function readCookie(name: string): string | undefined {
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
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string; issues?: unknown };
    if (res.status === 401) window.dispatchEvent(new CustomEvent('termhub:unauthorized'));
    throw new ApiError(res.status, d.error ?? `Erro ${res.status}`, d.code, d.issues);
  }
  return data as T;
}

export const api = {
  auth: {
    config: () => request<AuthConfig>('GET', '/auth/config'),
    me: () => request<{ user: User }>('GET', '/auth/me'),
    login: (email: string, password: string) => request<{ user: User }>('POST', '/auth/login', { email, password }),
    sendCode: (email: string) => request<{ ok: true; ttl_minutes: number }>('POST', '/auth/code/send', { email }),
    verifyCode: (email: string, code: string) => request<{ user: User }>('POST', '/auth/code/verify', { email, code }),
    logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  },
  machines: {
    list: () => request<{ machines: Machine[] }>('GET', '/machines'),
    create: (input: Partial<Machine>) => request<{ machine: Machine }>('POST', '/machines', input),
    update: (id: string, input: Partial<Machine>) => request<{ machine: Machine }>('PATCH', `/machines/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/machines/${id}`),
    status: (id: string) => request<{ id: string; online: boolean; tmux: boolean; os: string | null; capabilities: string[] }>('GET', `/machines/${id}/status`),
    simulators: (id: string) => request<{ simulators: Simulator[] }>('GET', `/machines/${id}/simulators`),
    wdaSetup: (id: string) => request<WdaSetupState>('GET', `/machines/${id}/simulator/setup`),
    startWdaSetup: (id: string) => request<{ ok: true }>('POST', `/machines/${id}/simulator/setup`, {}),
    /** subpastas de `path` (padrão $HOME) + discos/mounts da máquina */
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
  tasks: {
    list: (projectId: string) => request<{ tasks: Task[] }>('GET', `/projects/${projectId}/tasks`),
    create: (projectId: string, input: { title: string; description?: string | null; status?: TaskStatus }) =>
      request<{ task: Task }>('POST', `/projects/${projectId}/tasks`, input),
    update: (id: string, input: { title?: string; description?: string | null; status?: TaskStatus }) =>
      request<{ task: Task }>('PATCH', `/tasks/${id}`, input),
    move: (id: string, status: TaskStatus, position: number) => request<{ task: Task }>('POST', `/tasks/${id}/move`, { status, position }),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/tasks/${id}`),
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
  system: {
    sshKey: () => request<{ public_key: string | null; file: string | null }>('GET', '/system/ssh-key'),
  },
  tabs: {
    rename: (id: string, name: string) => request<{ tab: Tab }>('PATCH', `/tabs/${id}`, { name }),
    remove: (id: string) => request<{ ok: true; killed: boolean }>('DELETE', `/tabs/${id}`),
    update: (id: string, input: { name?: string; simulator_udid?: string | null }) => request<{ tab: Tab }>('PATCH', `/tabs/${id}`, input),
    screenshotUrl: (id: string) => `/api/tabs/${id}/simulator/screenshot`,
    /** grava a imagem em ~/.cache/termhub/paste/ na máquina da tab e devolve o caminho */
    pasteImage: (id: string, image: Blob) => request<{ path: string; bytes: number; mime: string }>('POST', `/tabs/${id}/paste-image`, image),
  },
};
