import { expect, it, vi } from 'vitest';

// The control layer is stubbed: these tests pin what the tool adapters hand the model.
vi.mock('../control/tickets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../control/tickets.js')>()),
  importTickets: vi.fn(async () => ({ cards: [{ ticket_key: 'EI-5', card: { id: 'k1', ref: 'P1-7' }, task: { id: 'k1', external_key: 'linear:u', external_ref: { id: 'u' } }, created: true }] })),
  pushTicketStatus: vi.fn(async () => ({ card: { id: 'k1', ref: 'P1-7' }, task: { id: 'k1', external_key: 'linear:u', external_ref: { id: 'u' } }, ticket_key: 'EI-5', state: 'Done' })),
}));

import type { ControlContext } from '../control/context.js';
import { parseArgs, TOOLS } from './tools.js';

it('read_screen says what ⟦…⟧ means and what styled: false means', () => {
  const d = TOOLS.find((t) => t.name === 'read_screen')!.description;
  expect(d).toContain('Text between ⟦ and ⟧ is dimmed');
  expect(d).toContain('never report it as an unsent message and never press Enter because of it');
  expect(d).toContain('styled: false');
});

it('link_project_machine, set_project_machine_cwd and unlink_project_machine are exposed with the right scope and grant', () => {
  const link = TOOLS.find((t) => t.name === 'link_project_machine')!;
  expect(link.scope).toBe('terminals');
  expect(link.resource).toBe('projects');
  expect(link.action).toBe('create');

  const setCwd = TOOLS.find((t) => t.name === 'set_project_machine_cwd')!;
  expect(setCwd.scope).toBe('terminals');
  expect(setCwd.resource).toBe('projects');
  expect(setCwd.action).toBe('update');

  const unlink = TOOLS.find((t) => t.name === 'unlink_project_machine')!;
  expect(unlink.scope).toBe('terminals');
  expect(unlink.resource).toBe('projects');
  expect(unlink.action).toBe('delete');
});

it('link_project_machine and set_project_machine_cwd refuse a relative cwd and accept a ~ path', () => {
  const link = TOOLS.find((t) => t.name === 'link_project_machine')!;
  expect(parseArgs(link, { project_id: 'p1', machine_id: 'm1', cwd: 'termhub' }).ok).toBe(false);
  expect(parseArgs(link, { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub' }).ok).toBe(true);

  const setCwd = TOOLS.find((t) => t.name === 'set_project_machine_cwd')!;
  expect(parseArgs(setCwd, { project_id: 'p1', machine_id: 'm1', cwd: 'termhub' }).ok).toBe(false);
  expect(parseArgs(setCwd, { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub' }).ok).toBe(true);
});

it('unlink_project_machine takes project_id, machine_id and an optional confirm', () => {
  const unlink = TOOLS.find((t) => t.name === 'unlink_project_machine')!;
  expect(parseArgs(unlink, { project_id: 'p1', machine_id: 'm1' }).ok).toBe(true);
  expect(parseArgs(unlink, { project_id: 'p1', machine_id: 'm1', confirm: true }).ok).toBe(true);
  expect(parseArgs(unlink, { machine_id: 'm1' }).ok).toBe(false);
});

it('ticket tools carry the right scope, grant and inputs', () => {
  const by = (n: string) => TOOLS.find((t) => t.name === n)!;
  expect([by('list_tickets').scope, by('list_tickets').resource, by('list_tickets').action]).toEqual(['read', 'tickets', 'read']);
  expect([by('get_ticket').scope, by('get_ticket').resource, by('get_ticket').action]).toEqual(['read', 'tickets', 'read']);
  expect([by('sync_tickets').scope, by('sync_tickets').resource, by('sync_tickets').action]).toEqual(['tasks', 'tickets', 'update']);
  expect([by('import_tickets').scope, by('import_tickets').resource, by('import_tickets').action]).toEqual(['tasks', 'tasks', 'create']);
  expect([by('push_ticket_status').scope, by('push_ticket_status').resource, by('push_ticket_status').action]).toEqual(['tasks', 'tasks', 'update']);
  expect(parseArgs(by('list_tickets'), { project_id: 'p', limit: 201 }).ok).toBe(false);
  expect(parseArgs(by('import_tickets'), { project_id: 'p', keys: ['EI-1'] }).ok).toBe(true);
  expect(parseArgs(by('get_ticket'), { key: 'EI-1' }).ok).toBe(true);
  expect(parseArgs(by('find'), { query: 'EI-1', kinds: ['ticket'] }).ok).toBe(true);
});

it('import_tickets and push_ticket_status hand the model the card, never the raw task (sync key, raw link)', async () => {
  const ctx = {} as ControlContext;
  const signal = new AbortController().signal;
  const imported = await TOOLS.find((t) => t.name === 'import_tickets')!.run(ctx, { project_id: 'p1', keys: ['EI-5'] }, signal);
  expect(imported).toEqual({ cards: [{ ticket_key: 'EI-5', card: { id: 'k1', ref: 'P1-7' }, created: true }] });
  const pushed = await TOOLS.find((t) => t.name === 'push_ticket_status')!.run(ctx, { task_id: 'k1' }, signal);
  expect(pushed).toEqual({ card: { id: 'k1', ref: 'P1-7' }, ticket_key: 'EI-5', state: 'Done' });
});

it('find says ticket matches carry project_id and card, and get_ticket has the full description', () => {
  const d = TOOLS.find((t) => t.name === 'find')!.description;
  expect(d).toContain('project_id');
  expect(d).toContain('card');
  expect(d).toContain('get_ticket');
});
