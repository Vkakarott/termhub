// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project } from '../lib/types';

const { linkMachine, updateProjectMachine, unlinkMachine } = vi.hoisted(() => ({ linkMachine: vi.fn(), updateProjectMachine: vi.fn(), unlinkMachine: vi.fn() }));
const machines = [{ id: 'm1', name: 'mac' }, { id: 'm2', name: 'jarvis' }] as Machine[];
vi.mock('../lib/data', () => ({
  useData: () => ({
    machines,
    statuses: { m1: 'online', m2: 'offline' },
    machinesOf: (p: Project) => p.machines.map((l) => machines.find((m) => m.id === l.machine_id)!),
    linkMachine,
    updateProjectMachine,
    unlinkMachine,
  }),
}));
vi.mock('./DirectoryBrowser', () => ({ DirectoryBrowser: () => null }));

import { ProjectMachines } from './ProjectMachines';

const project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/src/p1', position: 0 }] } as Project;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectMachines', () => {
  it('lists the links and offers only unlinked machines to add', () => {
    render(<ProjectMachines project={project} />);
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/src/p1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    const options = Array.from((screen.getByLabelText('Máquina') as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);
    expect(options).toEqual(['m2']);
  });

  it('links a machine with its directory', async () => {
    linkMachine.mockResolvedValue(undefined);
    render(<ProjectMachines project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    fireEvent.change(screen.getByLabelText('Máquina'), { target: { value: 'm2' } });
    fireEvent.change(screen.getByLabelText('Diretório'), { target: { value: '/w' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await waitFor(() => expect(linkMachine).toHaveBeenCalledWith('p1', { machine_id: 'm2', cwd: '/w', create_dir: true }));
  });

  it('saves an edited directory and unlinks after confirming', async () => {
    updateProjectMachine.mockResolvedValue(undefined);
    unlinkMachine.mockResolvedValue(2);
    render(<ProjectMachines project={project} />);
    fireEvent.change(screen.getByDisplayValue('/src/p1'), { target: { value: '/moved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateProjectMachine).toHaveBeenCalledWith('p1', 'm1', '/moved', false));
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular' })); // the row's link
    fireEvent.click(screen.getAllByRole('button', { name: 'Desvincular' })[1]); // the dialog's confirm
    await waitFor(() => expect(unlinkMachine).toHaveBeenCalledWith('p1', 'm1'));
    await screen.findByText('2 tabs fechadas.');
  });
});
