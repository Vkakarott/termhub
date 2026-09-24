// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/types';

const { createMock, updateMachineMock } = vi.hoisted(() => ({ createMock: vi.fn(), updateMachineMock: vi.fn() }));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { role_info: { is_admin: false } } }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ updateMachine: updateMachineMock, refresh: vi.fn(async () => {}), claimLocal: vi.fn() }) }));
vi.mock('../lib/api', () => ({
  api: { machines: { create: createMock }, users: { list: vi.fn() } },
  ApiError: class ApiError extends Error {},
}));
vi.mock('./AgentEnrollment', () => ({ AgentEnrollment: () => null }));
vi.mock('./AgentUpdateCard', () => ({ AgentUpdateCard: () => null }));
vi.mock('./MonitorHooksCard', () => ({ MonitorHooksCard: () => null }));
vi.mock('./SimulatorSetupCard', () => ({ SimulatorSetupCard: () => null }));

import { MachineForm } from './MachineForm';

const machine = {
  id: 'm1', name: 'mini', subtitle: 'MacBook do escritório', host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: [],
  checked_at: null, agent_version: null, agent_last_seen_at: null, agent_auto_update: false, is_local: false, owner_id: 'u1', owner_name: null,
  created_at: '',
} as Machine;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MachineForm subtitle', () => {
  it('offers a "Subtítulo" field under the name and sends it on create', async () => {
    createMock.mockResolvedValue({ machine: { ...machine, id: 'm-new' } });
    render(<MachineForm open onClose={() => {}} />);
    const subtitle = screen.getByLabelText('Subtítulo');
    expect(subtitle).toHaveAttribute('placeholder', expect.stringContaining('MacBook do escritório'));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'mini' } });
    fireEvent.change(subtitle, { target: { value: 'notebook da sala' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'mini', subtitle: 'notebook da sala' })));
  });

  it('starts from the machine\'s subtitle on edit and sends the new one, a cleared field as null', async () => {
    updateMachineMock.mockResolvedValue(machine);
    render(<MachineForm open onClose={() => {}} machine={machine} />);
    const subtitle = screen.getByLabelText('Subtítulo');
    expect(subtitle).toHaveValue('MacBook do escritório');
    fireEvent.change(subtitle, { target: { value: 'servidor da sala' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', expect.objectContaining({ subtitle: 'servidor da sala' })));
    fireEvent.change(subtitle, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMachineMock).toHaveBeenLastCalledWith('m1', expect.objectContaining({ subtitle: null })));
  });
});
