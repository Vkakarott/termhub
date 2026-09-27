import { describe, expect, it } from 'vitest';
import { readTicketLink, ticketLinkJson } from './ticket-link.js';

describe('ticket link', () => {
  it('writes the new names and the legacy ones the previous release reads', () => {
    const json = ticketLinkJson(
      { provider: 'github', provider_id: '12', key: 'acme/api#12', url: 'u', state: 'open', status: 'backlog', updated_at: 'x', meta: { labels: ['bug'], key: 'meta must not win' } },
      { integration_id: 'i1', scope: 'acme/api' },
    );
    expect(json).toMatchObject({ provider: 'github', key: 'acme/api#12', identifier: 'acme/api#12', provider_id: '12', id: '12', integration_id: 'i1', scope: 'acme/api', labels: ['bug'], updated_at: 'x' });
  });

  it('reads a link written by this release', () => {
    expect(readTicketLink({ provider: 'linear', key: 'EI-1', provider_id: 'uuid', url: 'u', state: 'Todo', status: 'todo', scope: 'EI', integration_id: 'i1' }))
      .toEqual({ provider: 'linear', key: 'EI-1', provider_id: 'uuid', url: 'u', state: 'Todo', status: 'todo', scope: 'EI', integration_id: 'i1' });
  });

  it('reads a legacy GitHub link: #12 + scope becomes owner/repo#12, id becomes provider_id, no integration_id', () => {
    expect(readTicketLink({ provider: 'github', id: '12', identifier: '#12', url: 'u', state: 'open', status: 'backlog', scope: 'acme/api' }))
      .toEqual({ provider: 'github', key: 'acme/api#12', provider_id: '12', url: 'u', state: 'open', status: 'backlog', scope: 'acme/api', integration_id: null });
  });

  it('returns null for anything that is not a link', () => {
    expect(readTicketLink(null)).toBeNull();
    expect(readTicketLink({ provider: 'gitlab', key: 'x' })).toBeNull();
    expect(readTicketLink('EI-1')).toBeNull();
  });
});
