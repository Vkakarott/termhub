import { afterEach, describe, expect, it, vi } from 'vitest';
import { jiraProvider } from './jira.js';

const issue = (k: string) => ({ id: `id-${k}`, key: k, fields: { summary: 's', description: null, updated: 'x', status: { name: 'To Do', statusCategory: { key: 'new' } } } });
const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const cfg = { baseUrl: 'https://acme.atlassian.net', email: 'a@b' };

afterEach(() => vi.unstubAllGlobals());

describe('jira.listTickets', () => {
  it('is open-only and follows nextPageToken', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(res({ issues: [issue('P-1')], nextPageToken: 'n1' }))
      .mockResolvedValueOnce(res({ issues: [issue('P-2')], isLast: true }));
    vi.stubGlobal('fetch', fetch);
    const r = await jiraProvider.listTickets('t', cfg, { provider: 'jira', integration_id: 'i', scope: 'P' });
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    expect(first.jql).toContain('statusCategory != Done');
    expect(JSON.parse(fetch.mock.calls[1][1].body).nextPageToken).toBe('n1');
    expect(r.tickets.map((t) => [t.key, t.provider_id, t.sync_key])).toEqual([['P-1', 'id-P-1', 'jira:P-1'], ['P-2', 'id-P-2', 'jira:P-2']]);
  });
});
