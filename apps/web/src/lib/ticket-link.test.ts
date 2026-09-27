import { describe, expect, it } from 'vitest';
import { ticketKey } from './ticket-link';

describe('ticketKey', () => {
  it('prefers key, rebuilds a legacy GitHub #n with its scope, falls back to identifier', () => {
    expect(ticketKey({ provider: 'linear', id: 'u', identifier: 'EI-1', key: 'EI-1', url: '', state: '', status: 'todo' })).toBe('EI-1');
    expect(ticketKey({ provider: 'github', id: '4', identifier: '#4', url: '', state: '', status: 'backlog', scope: 'acme/api' })).toBe('acme/api#4');
    expect(ticketKey({ provider: 'jira', id: '1', identifier: 'P-1', url: '', state: '', status: 'todo' })).toBe('P-1');
  });
});
