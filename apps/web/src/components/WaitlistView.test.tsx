// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, WaitlistEntry } from '../lib/types';

const api = vi.hoisted(() => ({
  waitlist: { list: vi.fn(), remove: vi.fn() },
  roles: { list: vi.fn() },
  users: { inviteFromWaitlist: vi.fn() },
}));
const auth = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock('../lib/api', () => ({ api, ApiError: class ApiError extends Error {} }));
vi.mock('../lib/auth', () => ({ useAuth: () => auth }));

import { WaitlistView } from './WaitlistView';

const roles: Role[] = [
  { id: 'r-admin', name: 'ADMIN', label: 'Administrador', description: null, is_system: true, is_admin: true, created_at: '' },
  { id: 'r-auth', name: 'AUTHENTICATED', label: 'Autenticado', description: null, is_system: true, is_admin: false, created_at: '' },
];

function entry(overrides: Partial<WaitlistEntry>): WaitlistEntry {
  return {
    id: 'w1', first_name: 'Ana', last_name: 'Lima', email: 'ana@gmail.com', phone_country: '55', phone_area: '62', phone_number: '999990000',
    phone: '+5562999990000', linkedin: null, github: null, locale: 'pt', source: 'landing', created_at: '2026-09-18T12:00:00.000Z', invited_at: null, ...overrides,
  };
}

const ana = entry({});
const bob = entry({ id: 'w2', first_name: 'Bob', email: 'bob@gmail.com', invited_at: '2026-09-17T15:30:00.000Z' });

beforeEach(() => {
  auth.can.mockImplementation((resource: string, action?: string) => resource === 'users' && action === 'create');
  api.waitlist.list.mockResolvedValue({ entries: [ana, bob] });
  api.roles.list.mockResolvedValue({ roles });
  api.users.inviteFromWaitlist.mockResolvedValue({ results: [{ id: 'w1', user_id: 'u1', existing: false, access: { configured: false, synced: false }, mail: { sent: true } }] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row = (email: string) => screen.getByText(email).closest('tr')!;

describe('WaitlistView invites', () => {
  it('offers "Convidar" on a fresh entry and "Reenviar" with the date on an invited one', async () => {
    render(<WaitlistView />);
    await screen.findByText('ana@gmail.com');
    expect(within(row('ana@gmail.com')).getByRole('button', { name: 'Convidar' })).toBeTruthy();
    expect(within(row('bob@gmail.com')).getByRole('button', { name: 'Reenviar' })).toBeTruthy();
    expect(within(row('bob@gmail.com')).getByText(/convidado em 17\/09\/2026/i)).toBeTruthy();
  });

  it('hides the invite controls without users:create', async () => {
    auth.can.mockReturnValue(false);
    render(<WaitlistView />);
    await screen.findByText('ana@gmail.com');
    expect(screen.queryByRole('button', { name: 'Convidar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reenviar' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('invites one entry with the role picked in the dialog (AUTHENTICATED by default) and marks the row', async () => {
    render(<WaitlistView />);
    await screen.findByText('ana@gmail.com');
    fireEvent.click(within(row('ana@gmail.com')).getByRole('button', { name: 'Convidar' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('ana@gmail.com')).toBeTruthy();
    const select = (await within(dialog).findByLabelText('Role')) as HTMLSelectElement;
    expect(select.value).toBe('r-auth');
    fireEvent.click(within(dialog).getByRole('button', { name: /Enviar convite/ }));
    await waitFor(() => expect(api.users.inviteFromWaitlist).toHaveBeenCalledWith({ ids: ['w1'], role_id: 'r-auth' }));
    await within(dialog).findByText(/1 convite enviado/i);
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Fechar' }).at(-1)!);
    expect(within(row('ana@gmail.com')).getByRole('button', { name: 'Reenviar' })).toBeTruthy();
  });

  it('invites the checked entries in one batch', async () => {
    api.users.inviteFromWaitlist.mockResolvedValue({
      results: [
        { id: 'w1', user_id: 'u1', existing: false, access: { configured: false, synced: false }, mail: { sent: true } },
        { id: 'w2', user_id: 'u2', existing: true, access: { configured: false, synced: false }, mail: { sent: false, error: 'smtp down' } },
      ],
    });
    render(<WaitlistView />);
    await screen.findByText('ana@gmail.com');
    expect(screen.queryByRole('button', { name: /Convidar selecionados/ })).toBeNull();
    fireEvent.click(within(row('ana@gmail.com')).getByRole('checkbox'));
    fireEvent.click(within(row('bob@gmail.com')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Convidar selecionados (2)' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Enviar convites/ }));
    await waitFor(() => expect(api.users.inviteFromWaitlist).toHaveBeenCalledWith({ ids: ['w1', 'w2'], role_id: 'r-auth' }));
    await within(dialog).findByText(/1 convite enviado/i);
    expect(within(dialog).getByText(/smtp down/)).toBeTruthy();
  });
});
