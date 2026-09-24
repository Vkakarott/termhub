// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewAs } from '../lib/types';

const auth = vi.hoisted(() => ({ viewAs: null as ViewAs }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' }, viewAs: auth.viewAs }) }));

import { ProfileButton } from './ProfileButton';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function mount(variant: 'row' | 'rail') {
  render(
    <MemoryRouter initialEntries={['/machines']}>
      <ProfileButton variant={variant} />
      <Where />
    </MemoryRouter>,
  );
}
const button = () => screen.getByRole('button', { name: /configurações e perfil/ });

beforeEach(() => {
  auth.viewAs = null;
});
afterEach(cleanup);

describe('ProfileButton', () => {
  it('the row is one button with the name that opens Perfil, its name holding the visible text', () => {
    mount('row');
    expect(button()).toHaveAccessibleName('Pedro — configurações e perfil');
    expect(button()).toHaveTextContent('Pedro');
    expect(button().querySelector('svg')).not.toBeNull(); // the Settings gear
    expect(button()).toHaveAttribute('data-chrome-focus', 'profile');
    fireEvent.click(button());
    expect(screen.getByTestId('where').textContent).toBe('/settings/profile');
  });

  it('the rail shows only the avatar, with the same destination', () => {
    mount('rail');
    expect(button()).toHaveAccessibleName('Pedro — configurações e perfil');
    expect(button()).not.toHaveTextContent('Pedro');
    expect(button()).toHaveAttribute('data-chrome-focus', 'profile');
    fireEvent.click(button());
    expect(screen.getByTestId('where').textContent).toBe('/settings/profile');
  });

  it('the row says, in warning colours, whose data is on screen while "Ver como" is on', () => {
    mount('row');
    expect(screen.queryByText(/Vendo/)).toBeNull();
    cleanup();
    auth.viewAs = { id: 'u2', name: 'Fulano', email: 'f@example.com', avatar_url: null };
    mount('row');
    expect(screen.getByText('Vendo como Fulano')).toHaveClass('text-warn');
    expect(button()).toHaveAccessibleName('Pedro — configurações e perfil — Vendo como Fulano');
    fireEvent.click(button());
    expect(screen.getByTestId('where').textContent).toBe('/settings/profile');
  });

  it('the row says so for every machine too', () => {
    auth.viewAs = 'all';
    mount('row');
    expect(screen.getByText('Vendo: todas as máquinas')).toBeInTheDocument();
  });

  it('the rail marks the avatar and says it in the name and the tooltip', () => {
    auth.viewAs = { id: 'u2', name: 'Fulano', email: 'f@example.com', avatar_url: null };
    mount('rail');
    expect(button()).toHaveAccessibleName('Pedro — configurações e perfil — Vendo como Fulano');
    expect(button()).toHaveAttribute('title', 'Pedro — configurações e perfil — Vendo como Fulano');
    expect(button().querySelector('[data-view-as]')).not.toBeNull();
    cleanup();
    auth.viewAs = null;
    mount('rail');
    expect(button().querySelector('[data-view-as]')).toBeNull();
  });
});
