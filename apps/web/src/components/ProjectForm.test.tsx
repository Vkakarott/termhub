// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createProject, keyAvailable } = vi.hoisted(() => ({ createProject: vi.fn(), keyAvailable: vi.fn() }));
vi.mock('../lib/data', () => ({ useData: () => ({ createProject, machines: [{ id: 'm1', name: 'mac', type: 'agent', capabilities: [] }] }) }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { projects: { keyAvailable } } }));

import { ProjectForm } from './ProjectForm';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = (machineId?: string) => render(
  <MemoryRouter>
    <ProjectForm open onClose={() => {}} machineId={machineId} />
  </MemoryRouter>,
);

describe('ProjectForm', () => {
  it('suggests a key from the name and checks its availability', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    mount();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Hub Community' } });
    expect((screen.getByLabelText('Chave') as HTMLInputElement).value).toBe('HC');
    await waitFor(() => expect(keyAvailable).toHaveBeenCalledWith('HC'));
    await screen.findByText('disponível');
  });

  it('shows "já em uso" and blocks submit for a taken key; a hand-edited key is kept', async () => {
    keyAvailable.mockResolvedValue({ available: false, reason: 'taken' });
    mount();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Hub Community' } });
    fireEvent.change(screen.getByLabelText('Chave'), { target: { value: 'HUB' } });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Hub Community 2' } });
    expect((screen.getByLabelText('Chave') as HTMLInputElement).value).toBe('HUB');
    await screen.findByText('já em uso');
    expect(screen.getByRole('button', { name: 'Criar' })).toBeDisabled();
  });

  it('creates without a machine when none is chosen, and with machine + cwd when one is', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    createProject.mockResolvedValue({ id: 'new' });
    mount();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Novo' } });
    await screen.findByText('disponível');
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: 'Novo', key: 'NOV', description: null }));

    cleanup();
    mount('m1');
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Outro' } });
    fireEvent.change(screen.getByLabelText('Diretório (caminho absoluto na máquina)'), { target: { value: '/src/outro' } });
    await screen.findByText('disponível');
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(createProject).toHaveBeenLastCalledWith({ name: 'Outro', key: 'OUT', description: null, machine_id: 'm1', cwd: '/src/outro', create_dir: true }));
  });
});
