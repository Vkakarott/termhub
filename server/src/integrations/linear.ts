import type { ConnectionInfo, ExternalTicket, TicketProvider, TicketSourceConfig } from './types.js';

const API = 'https://api.linear.app/graphql';

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) throw new Error(`Linear: ${body.errors?.[0]?.message ?? res.status}`);
  return body.data as T;
}

/** Tipos de estado do Linear → kanban. */
function mapState(type: string): ExternalTicket['status'] {
  if (type === 'started') return 'doing';
  if (type === 'completed' || type === 'canceled') return 'done';
  return 'todo'; // backlog, unstarted, triage
}

export const linear: TicketProvider = {
  provider: 'linear',

  async testConnection(secret): Promise<ConnectionInfo> {
    try {
      const data = await gql<{ viewer: { name: string; email: string }; teams: { nodes: { id: string; key: string; name: string }[] } }>(
        secret,
        `query { viewer { name email } teams(first: 50) { nodes { id key name } } }`,
      );
      return {
        ok: true,
        account: data.viewer.email,
        options: { teams: data.teams.nodes.map((t) => ({ id: t.key, name: `${t.name} (${t.key})` })) },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async listTickets(secret, _config, source: TicketSourceConfig) {
    const stateFilter = source.include_done ? {} : { state: { type: { nin: ['completed', 'canceled'] } } };
    const nameFilter = source.filter
      ? { state: { name: { in: source.filter.split(',').map((s) => s.trim()).filter(Boolean) } } }
      : {};
    const data = await gql<{
      issues: {
        nodes: {
          id: string;
          identifier: string;
          title: string;
          description: string | null;
          url: string;
          updatedAt: string;
          priority: number;
          state: { name: string; type: string };
          assignee: { name: string } | null;
          labels: { nodes: { name: string }[] };
        }[];
      };
    }>(
      secret,
      `query($filter: IssueFilter) {
        issues(filter: $filter, first: 100, orderBy: updatedAt) {
          nodes { id identifier title description url updatedAt priority state { name type } assignee { name } labels { nodes { name } } }
        }
      }`,
      { filter: { team: { key: { eq: source.scope } }, ...stateFilter, ...nameFilter } },
    );
    return data.issues.nodes.map<ExternalTicket>((i) => ({
      key: `linear:${i.id}`,
      provider: 'linear',
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      description: i.description,
      url: i.url,
      state: i.state.name,
      status: mapState(i.state.type),
      updatedAt: i.updatedAt,
      meta: { priority: i.priority, assignee: i.assignee?.name ?? null, labels: i.labels.nodes.map((l) => l.name) },
    }));
  },
};
