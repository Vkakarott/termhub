import type { AuthConfig, Machine, Project, Tab, User } from './types';

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
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie('termhub_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
    logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  },
  machines: {
    list: () => request<{ machines: Machine[] }>('GET', '/machines'),
    create: (input: Partial<Machine>) => request<{ machine: Machine }>('POST', '/machines', input),
    update: (id: string, input: Partial<Machine>) => request<{ machine: Machine }>('PATCH', `/machines/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/machines/${id}`),
    status: (id: string) => request<{ id: string; online: boolean }>('GET', `/machines/${id}/status`),
  },
  projects: {
    list: () => request<{ projects: Project[] }>('GET', '/projects'),
    get: (id: string) => request<{ project: Project }>('GET', `/projects/${id}`),
    create: (input: Partial<Project>) => request<{ project: Project }>('POST', '/projects', input),
    update: (id: string, input: Partial<Project>) => request<{ project: Project }>('PATCH', `/projects/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/projects/${id}`),
    tabs: (id: string) => request<{ reachable: boolean; tabs: Tab[] }>('GET', `/projects/${id}/tabs`),
    createTab: (id: string, name?: string) => request<{ tab: Tab }>('POST', `/projects/${id}/tabs`, name ? { name } : {}),
  },
  tabs: {
    rename: (id: string, name: string) => request<{ tab: Tab }>('PATCH', `/tabs/${id}`, { name }),
    remove: (id: string) => request<{ ok: true; killed: boolean }>('DELETE', `/tabs/${id}`),
  },
};
