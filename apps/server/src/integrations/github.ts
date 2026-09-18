import type { ConnectionInfo, ExternalTicket, TicketProvider, TicketSourceConfig } from './types.js';

const API = 'https://api.github.com';

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'termhub', 'content-type': 'application/json' },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export const github: TicketProvider = {
  provider: 'github',

  async testConnection(secret) {
    try {
      const me = await gh<{ login: string }>(secret, '/user');
      const repos = await gh<{ full_name: string }[]>(secret, '/user/repos?per_page=100&sort=pushed');
      return { ok: true, account: me.login, options: { repos: repos.map((r) => ({ id: r.full_name, name: r.full_name })) } };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async listTickets(secret, _config, source) {
    const [owner, repo] = source.scope.split('/');
    if (!owner || !repo) throw new Error('scope do GitHub deve ser owner/repo');
    const state = source.include_done ? 'all' : 'open';
    const labels = source.filter ? `&labels=${encodeURIComponent(source.filter)}` : '';
    const issues = await gh<
      { number: number; title: string; body: string | null; html_url: string; state: string; updated_at: string; pull_request?: unknown; labels: { name: string }[]; assignee: { login: string } | null }[]
    >(secret, `/repos/${owner}/${repo}/issues?state=${state}&per_page=100${labels}`);
    return issues
      .filter((i) => !i.pull_request)
      .map<ExternalTicket>((i) => ({
        key: `github:${owner}/${repo}#${i.number}`,
        provider: 'github',
        id: String(i.number),
        identifier: `#${i.number}`,
        title: i.title,
        description: i.body,
        url: i.html_url,
        state: i.state,
        status: i.state === 'closed' ? 'done' : i.assignee ? 'doing' : 'backlog',
        updatedAt: i.updated_at,
        meta: { labels: i.labels.map((l) => l.name), assignee: i.assignee?.login ?? null },
      }));
  },

  async updateStatus(secret, _config, ticket, status) {
    const [owner, repo] = ticket.scope.split('/');
    const state = status === 'done' ? 'closed' : 'open';
    await gh(secret, `/repos/${owner}/${repo}/issues/${ticket.id}`, { method: 'PATCH', body: JSON.stringify({ state }) });
    return state;
  },
};
