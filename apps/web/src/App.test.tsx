// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The layouts become bare outlets and every page a marker: only the route table is under test.
vi.mock('./components/Layout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { AppShell: () => <Outlet />, Layout: () => <Outlet />, FullScreenMessage: ({ children }: { children: ReactNode }) => <p>{children}</p> };
});
vi.mock('./components/ChatLayout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { ChatLayout: () => <Outlet /> };
});
vi.mock('./pages/LoginPage', () => ({ LoginPage: () => <p>login-page</p> }));
vi.mock('./pages/HomePage', () => ({ HomePage: () => <p>home-page</p> }));
vi.mock('./pages/ProjectPage', () => ({ ProjectPage: () => <p>project-page</p> }));
vi.mock('./pages/ChatPage', () => ({ ChatPage: () => <p>chat-page</p> }));
vi.mock('./pages/MachinesPage', () => ({ MachinesPage: () => <p>machines-page</p> }));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => <p>settings-page</p> }));

import { AppRoutes } from './App';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

afterEach(cleanup);

describe('AppRoutes', () => {
  it.each([
    ['/waitlist', '/settings/waitlist'],
    ['/ai', '/settings/ai'],
    ['/hardware', '/settings/hardware'],
  ])('sends the old %s tab to its settings section', (from, to) => {
    render(
      <MemoryRouter initialEntries={[from]}>
        <AppRoutes />
        <Where />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe(to);
    expect(screen.getByText('settings-page')).toBeTruthy();
  });


  it('sends the old /integrations address to the Integrações settings section', () => {
    render(
      <MemoryRouter initialEntries={['/integrations']}>
        <AppRoutes />
        <Where />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/settings/integrations');
    expect(screen.getByText('settings-page')).toBeTruthy();
  });
});
