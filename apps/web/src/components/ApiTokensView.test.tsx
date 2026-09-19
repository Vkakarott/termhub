// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiTokensView, mcpAddCommand, tokenStatus } from './ApiTokensView';
import type { ApiToken } from '../lib/types';

const listMock = vi.fn();
const createMock = vi.fn();
const revokeMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: { apiTokens: { list: (...a: unknown[]) => listMock(...a), create: (...a: unknown[]) => createMock(...a), revoke: (...a: unknown[]) => revokeMock(...a) } },
  };
});

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));

const tok = (over: Partial<ApiToken> & { id: string }): ApiToken => ({
  user_id: 'u1',
  name: over.id,
  scopes: ['read'],
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  ...over,
});

const SECRET = 'thb_pat_' + 'A'.repeat(43);

beforeEach(() => {
  listMock.mockResolvedValue({ tokens: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('tokenStatus', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  it('is revoked, expired or active', () => {
    expect(tokenStatus(tok({ id: 'a', revoked_at: '2026-09-19T01:00:00.000Z' }), now)).toBe('revoked');
    expect(tokenStatus(tok({ id: 'b', expires_at: '2026-09-19T11:59:59.000Z' }), now)).toBe('expired');
    expect(tokenStatus(tok({ id: 'c', expires_at: '2026-09-20T00:00:00.000Z' }), now)).toBe('active');
    expect(tokenStatus(tok({ id: 'd' }), now)).toBe('active');
  });
});

describe('mcpAddCommand', () => {
  it('builds the claude mcp add command', () => {
    expect(mcpAddCommand('https://termhub.dev/mcp', SECRET)).toBe(`claude mcp add --transport http termhub https://termhub.dev/mcp --header "Authorization: Bearer ${SECRET}"`);
  });
});

describe('ApiTokensView', () => {
  it('lists tokens with their status', async () => {
    listMock.mockResolvedValue({
      tokens: [
        tok({ id: 'laptop', scopes: ['read', 'terminals'] }),
        tok({ id: 'old', expires_at: '2000-01-01T00:00:00.000Z' }),
        tok({ id: 'gone', revoked_at: '2026-09-19T01:00:00.000Z' }),
      ],
    });
    render(<ApiTokensView />);
    const laptop = (await screen.findByText('laptop')).closest('tr')!;
    expect(within(laptop).getByText('ler, terminais')).toBeTruthy();
    expect(within(laptop).getByText('nunca')).toBeTruthy();
    expect(within(screen.getByText('old').closest('tr')!).getByText('expirado')).toBeTruthy();
    expect(within(screen.getByText('gone').closest('tr')!).getByText('revogado')).toBeTruthy();
    expect(within(screen.getByText('gone').closest('tr')!).queryByRole('button', { name: /Revogar/ })).toBeNull();
  });

  it('creates a token, shows it once with the mcp command, and forgets it on close', async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new', name: 'laptop', scopes: ['read', 'tasks'] }), token: SECRET, mcp_url: 'https://termhub.dev/mcp' });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));

    const create = screen.getByRole('button', { name: 'Criar token' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: '  laptop ' } });
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByLabelText(/^Tarefas/));
    fireEvent.change(screen.getByLabelText('Validade'), { target: { value: '30' } });
    fireEvent.click(create);

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'laptop', scopes: ['read', 'tasks'], expires_in_days: 30 }));
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();
    expect(screen.getByText(/não aparece de novo/)).toBeTruthy();
    expect(screen.getByDisplayValue(mcpAddCommand('https://termhub.dev/mcp', SECRET))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Concluído' }));
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    expect(await screen.findByText('laptop')).toBeTruthy();
  });

  it('hides the mcp command when the server has no MCP_URL', async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new' }), token: SECRET, mcp_url: null });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar token' }));
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();
    expect(screen.queryByDisplayValue(/claude mcp add/)).toBeNull();
  });

  it('keeps Criar token disabled without a name or a scope', async () => {
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    const create = screen.getByRole('button', { name: 'Criar token' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'x' } });
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/^Terminais/));
    expect(create.disabled).toBe(false);
  });

  it('revokes after confirmation', async () => {
    listMock.mockResolvedValue({ tokens: [tok({ id: 'laptop' })] });
    revokeMock.mockResolvedValue({ api_token: tok({ id: 'laptop', revoked_at: '2026-09-19T02:00:00.000Z' }) });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar laptop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith('laptop'));
    expect(await screen.findByText('revogado')).toBeTruthy();
  });
});
