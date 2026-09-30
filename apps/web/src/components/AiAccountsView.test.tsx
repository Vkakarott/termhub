// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccount, Machine } from '../lib/types';

const listMock = vi.fn();
const usageMock = vi.fn();
const usageOfMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      aiAccounts: {
        list: (...a: unknown[]) => listMock(...a),
        usage: (...a: unknown[]) => usageMock(...a),
        usageOf: (...a: unknown[]) => usageOfMock(...a),
        create: (...a: unknown[]) => createMock(...a),
        update: (...a: unknown[]) => updateMock(...a),
      },
    },
  };
});
vi.mock('../lib/data', () => ({ useData: () => ({ machines: [{ id: 'm1', name: 'mac' }] as Machine[] }) }));
vi.mock('./AutoSwapSettings', () => ({ AutoSwapSettings: () => null }));

import { AiAccountsView } from './AiAccountsView';

const account = (over: Partial<AiAccount> & { id: string }): AiAccount => ({ provider: 'claude', label: over.id, machine_id: 'm1', config_dir: null, created_at: '', ...over });

beforeEach(() => {
  listMock.mockResolvedValue({ accounts: [] });
  usageMock.mockResolvedValue({ usage: [] });
  usageOfMock.mockResolvedValue({ usage: { account_id: 'x', ok: false, windows: [], error: null, hint: null, plan: null, fetched_at: '', stale: false } });
  createMock.mockImplementation(async (input: Partial<AiAccount>) => ({ account: account({ id: 'new', ...input }) }));
  updateMock.mockImplementation(async (id: string, input: Partial<AiAccount>) => ({ account: account({ id, ...input }) }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openNew() {
  render(<AiAccountsView />);
  await waitFor(() => expect(listMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '+ conta' }));
  return within(screen.getByRole('dialog'));
}

describe('AiAccountsView: which login an account is (TER-499)', () => {
  it("adds the machine's default login when nothing else is chosen", async () => {
    const form = await openNew();
    expect(form.getByRole('radio', { name: /Conta padrão da máquina/ })).toBeChecked();
    expect(form.queryByLabelText('Diretório de config')).not.toBeInTheDocument();
    fireEvent.click(form.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ provider: 'claude', label: 'Claude', machine_id: 'm1', config_dir: null }));
  });

  it('asks for the directory of another login and sends it', async () => {
    const form = await openNew();
    fireEvent.click(form.getByRole('radio', { name: /Outro diretório de config/ }));
    expect(form.getByRole('button', { name: 'Adicionar' })).toBeDisabled();
    fireEvent.change(form.getByLabelText('Diretório de config'), { target: { value: ' ~/.claude-work ' } });
    fireEvent.click(form.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ config_dir: '~/.claude-work' })));
  });

  it('opens an account on the login it has, and can turn it into the default one', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'work', config_dir: '~/.claude-work' })] });
    render(<AiAccountsView />);
    fireEvent.click(await screen.findByTitle('Editar'));
    const form = within(screen.getByRole('dialog'));
    expect(form.getByRole('radio', { name: /Outro diretório de config/ })).toBeChecked();
    expect(form.getByLabelText('Diretório de config')).toHaveValue('~/.claude-work');
    fireEvent.click(form.getByRole('radio', { name: /Conta padrão da máquina/ }));
    fireEvent.click(form.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('work', { label: 'work', machine_id: 'm1', config_dir: null }));
  });

  it('says on the card which account is the default login, and shows the directory of the others', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'home' }), account({ id: 'work', config_dir: '~/.claude-work' })] });
    render(<AiAccountsView />);
    const [home, work] = await screen.findAllByRole('listitem');
    expect(home).toHaveTextContent('mac · login padrão');
    expect(work).toHaveTextContent('mac · ~/.claude-work');
    expect(work).not.toHaveTextContent('login padrão');
  });
});
