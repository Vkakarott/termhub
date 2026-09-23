// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { deleteMachine, canMock } = vi.hoisted(() => ({ deleteMachine: vi.fn(), canMock: vi.fn(() => true) }));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: canMock, viewAs: 'self' }) }));
vi.mock('../lib/data', () => {
  const machines = [
    { id: 'm1', name: 'mac', type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: new Date().toISOString() },
    { id: 'm2', name: 'jarvis', type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: new Date().toISOString() },
  ];
  const projects = [
    { id: 'p1', key: 'ALPHA', name: 'alpha', status: 'active', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }] },
  ];
  return {
    useData: () => ({
      machines,
      projects,
      hiddenLocal: [],
      claimLocal: vi.fn(),
      statuses: {},
      missingTmux: {},
      deleteMachine,
      checkStatus: vi.fn(),
    }),
  };
});
vi.mock('../components/MachineForm', () => ({ MachineForm: ({ open }: { open: boolean }) => (open ? <div>machine-form-marker</div> : null) }));

import { MachinesPage } from './MachinesPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canMock.mockReturnValue(true);
});

const mount = () =>
  render(
    <MemoryRouter>
      <MachinesPage />
    </MemoryRouter>,
  );

describe('MachinesPage', () => {
  it('lists machines with their linked-project chips', () => {
    mount();
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByText('jarvis')).toBeInTheDocument();
    const jarvisRow = screen.getByText('jarvis').closest('li')!;
    expect(jarvisRow).toHaveTextContent('nenhum projeto');
    const macRow = screen.getByText('mac').closest('li')!;
    expect(macRow).toHaveTextContent('alpha');
  });

  it('"+ máquina" opens the machine form', () => {
    mount();
    expect(screen.queryByText('machine-form-marker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ máquina' }));
    expect(screen.getByText('machine-form-marker')).toBeInTheDocument();
  });

  it('deletes a machine after confirming', async () => {
    deleteMachine.mockResolvedValue(undefined);
    mount();
    const macRow = screen.getByText('mac').closest('li')!;
    fireEvent.click(within(macRow).getByRole('button', { name: '✕' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await Promise.resolve();
    expect(deleteMachine).toHaveBeenCalledWith('m1');
  });
});
