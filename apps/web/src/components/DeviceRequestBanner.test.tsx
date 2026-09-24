// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const summaryMock = vi.fn();
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { devices: { summary: (...a: unknown[]) => summaryMock(...a) } },
}));

const authMock = { can: (_resource: string) => true };
vi.mock('../lib/auth', () => ({ useAuth: () => authMock }));

import { DeviceRequestBanner } from './DeviceRequestBanner';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authMock.can = () => true;
});

beforeEach(() => {
  summaryMock.mockResolvedValue({ pending_requests: 0, active_devices: 0 });
});

function mount() {
  render(
    <MemoryRouter>
      <DeviceRequestBanner />
    </MemoryRouter>,
  );
}

describe('DeviceRequestBanner', () => {
  it('shows the notice and a link to Settings → Aparelhos when a phone is waiting', async () => {
    summaryMock.mockResolvedValue({ pending_requests: 1, active_devices: 0 });
    mount();
    expect(await screen.findByText('Um aparelho pede acesso à sua conta')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Ver pedido' });
    expect(link.getAttribute('href')).toBe('/settings/devices');
  });

  it('renders nothing when there is no pending request', async () => {
    summaryMock.mockResolvedValue({ pending_requests: 0, active_devices: 0 });
    mount();
    await waitFor(() => expect(summaryMock).toHaveBeenCalled());
    expect(screen.queryByText(/pede acesso/)).toBeNull();
  });

  it('never calls the API without the devices permission', async () => {
    authMock.can = () => false;
    mount();
    await Promise.resolve();
    expect(summaryMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/pede acesso/)).toBeNull();
  });
});
