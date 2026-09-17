import type { ConnectionInfo, ExternalTicket, TicketProvider, TicketSourceConfig } from './types.js';

/** Jira Cloud: config = { baseUrl: "https://xxx.atlassian.net", email }, secret = API token. */
function auth(config: Record<string, unknown>, token: string) {
  const email = String(config.email ?? '');
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

function base(config: Record<string, unknown>): string {
  const url = String(config.baseUrl ?? '').replace(/\/$/, '');
  if (!url.startsWith('http')) throw new Error('Jira: baseUrl inválida (ex.: https://empresa.atlassian.net)');
  return url;
}

async function jira<T>(config: Record<string, unknown>, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base(config)}${path}`, {
    ...init,
    headers: { authorization: auth(config, token), accept: 'application/json', 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

function mapCategory(key: string): ExternalTicket['status'] {
  if (key === 'indeterminate') return 'doing';
  if (key === 'done') return 'done';
  return 'todo'; // new / undefined
}

/** Descrição do Jira Cloud vem em ADF; extrai o texto puro. */
function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfToText).join('');
  return n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' ? inner + '\n' : inner;
}

export const jiraProvider: TicketProvider = {
  provider: 'jira',

  async testConnection(secret, config): Promise<ConnectionInfo> {
    try {
      const me = await jira<{ emailAddress?: string; displayName: string }>(config, secret, '/rest/api/3/myself');
      const projects = await jira<{ values: { key: string; name: string }[] }>(config, secret, '/rest/api/3/project/search?maxResults=100');
      return {
        ok: true,
        account: me.emailAddress ?? me.displayName,
        options: { projects: projects.values.map((p) => ({ id: p.key, name: `${p.name} (${p.key})` })) },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async listTickets(secret, config, source: TicketSourceConfig) {
    const parts = [`project = "${source.scope}"`];
    if (!source.include_done) parts.push('statusCategory != Done');
    if (source.filter) parts.push(`(${source.filter})`);
    const jql = parts.join(' AND ') + ' ORDER BY updated DESC';
    const data = await jira<{
      issues: {
        id: string;
        key: string;
        fields: {
          summary: string;
          description: unknown;
          updated: string;
          status: { name: string; statusCategory: { key: string } };
          priority?: { name: string } | null;
          assignee?: { displayName: string } | null;
          labels?: string[];
        };
      }[];
    }>(config, secret, '/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, maxResults: 100, fields: ['summary', 'description', 'updated', 'status', 'priority', 'assignee', 'labels'] }),
    });
    return data.issues.map<ExternalTicket>((i) => ({
      key: `jira:${i.key}`,
      provider: 'jira',
      id: i.id,
      identifier: i.key,
      title: i.fields.summary,
      description: i.fields.description ? adfToText(i.fields.description).trim() || null : null,
      url: `${base(config)}/browse/${i.key}`,
      state: i.fields.status.name,
      status: mapCategory(i.fields.status.statusCategory.key),
      updatedAt: i.fields.updated,
      meta: { priority: i.fields.priority?.name ?? null, assignee: i.fields.assignee?.displayName ?? null, labels: i.fields.labels ?? [] },
    }));
  },
};
