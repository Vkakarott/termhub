// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEnrollment } from './AgentEnrollment';
import type { Machine } from '../lib/types';

const statusMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    machines: {
      status: (...args: unknown[]) => statusMock(...args),
    },
  },
  ApiError: class ApiError extends Error {},
}));

const machine: Machine = {
  id: 'm1',
  name: 'minha-máquina',
  host: null,
  ssh_user: null,
  ssh_port: 22,
  type: 'agent',
  os: null,
  capabilities: [],
  checked_at: null,
  agent_version: null,
  agent_last_seen_at: null,
  owner_id: null,
  owner_name: null,
  created_at: new Date().toISOString(),
};

afterEach(() => {
  cleanup();
  statusMock.mockReset();
  vi.useRealTimers();
});

describe('AgentEnrollment', () => {
  it('renders the connect command with the token and window.location.origin', () => {
    statusMock.mockResolvedValue({ id: 'm1', online: false, tmux: false, os: null, capabilities: [] });
    render(<AgentEnrollment machine={machine} token="thb_ag_abc123" />);
    const expected = `termhub-agent connect --url ${window.location.origin} --token thb_ag_abc123`;
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.getByText('aguardando conexão…')).toBeTruthy();
  });

  it('shows "conectado" and calls onConnected once the status resolves online', async () => {
    statusMock.mockResolvedValue({ id: 'm1', online: true, tmux: true, os: 'macos', capabilities: [], agent_version: '1.2.3' });
    const onConnected = vi.fn();
    render(<AgentEnrollment machine={machine} token="thb_ag_abc123" onConnected={onConnected} />);

    await waitFor(() => expect(screen.getByText(/conectado/)).toBeTruthy());
    expect(screen.getByText(/macos/)).toBeTruthy();
    expect(screen.getByText(/1\.2\.3/)).toBeTruthy();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
