// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { authState } = vi.hoisted(() => ({ authState: { current: { can: (() => true) as (resource: string, action?: string) => boolean } } }));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
// Each section loads its own data; only the tab strip and which section is picked matter here.
vi.mock('../components/MyCityView', () => ({ MyCityView: () => <p>minha-cidade-view</p> }));
vi.mock('../components/ProfileView', () => ({ ProfileView: () => <p>profile-view</p> }));
vi.mock('../components/IntegrationsView', () => ({ IntegrationsView: () => <p>integrations-view</p> }));
vi.mock('../components/UploadsView', () => ({ UploadsView: () => null }));
vi.mock('../components/ApiTokensView', () => ({ ApiTokensView: () => null }));
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    users: { list: () => new Promise(() => {}), access: () => new Promise(() => {}) },
    roles: { list: () => new Promise(() => {}) },
  },
}));

import { SettingsPage } from './SettingsPage';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('SettingsPage', () => {
  it('lands a user without any settings permission on Perfil, with Minha cidade among the tabs', () => {
    authState.current = { can: () => false };
    renderAt('/settings');
    expect(screen.getByText('profile-view')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Minha cidade' }).getAttribute('href')).toBe('/settings/city');
    expect(screen.queryByRole('link', { name: 'Usuários' })).toBeNull();
  });

  it('lands an admin on Perfil too', () => {
    authState.current = { can: () => true };
    renderAt('/settings');
    expect(screen.getByText('profile-view')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Usuários' })).toBeTruthy();
  });

  it('opens Minha cidade from its own address', () => {
    authState.current = { can: () => true };
    renderAt('/settings/city');
    expect(screen.getByText('minha-cidade-view')).toBeTruthy();
  });

  it('opens Integrações as a section', () => {
    authState.current = { can: (r) => r === 'integrations' };
    renderAt('/settings/integrations');
    expect(screen.getByText('integrations-view')).toBeTruthy();
  });
});
