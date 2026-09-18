// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

  it('does not restart the polling interval when onConnected is a new function on every render', async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValue({ id: 'm1', online: false, tmux: false, os: null, capabilities: [] });

    const { rerender } = render(<AgentEnrollment machine={machine} token="thb_ag_abc123" onConnected={() => {}} />);
    // flush the immediate poll() fired by the mount effect
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusMock).toHaveBeenCalledTimes(1);

    // MachineForm re-renders AgentEnrollment with a brand-new onConnected closure on every
    // DataContext change (e.g. the 30 s status loop). That must not tear down and restart the
    // polling effect, which would otherwise re-fire poll() immediately.
    rerender(<AgentEnrollment machine={machine} token="thb_ag_abc123" onConnected={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusMock).toHaveBeenCalledTimes(1);

    // just before the next scheduled 3 s tick: still no extra call
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(statusMock).toHaveBeenCalledTimes(1);

    // the interval (started once, at mount) fires its next tick right on schedule
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(statusMock).toHaveBeenCalledTimes(2);
  });

  it('stops polling after unmount', async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValue({ id: 'm1', online: false, tmux: false, os: null, capabilities: [] });

    const { unmount } = render(<AgentEnrollment machine={machine} token="thb_ag_abc123" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(statusMock).toHaveBeenCalledTimes(1);
  });
});
