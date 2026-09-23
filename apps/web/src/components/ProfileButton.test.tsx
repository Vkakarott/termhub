// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' } }) }));

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

afterEach(cleanup);

describe('ProfileButton', () => {
  it('the row is one button with the name that opens Perfil', () => {
    mount('row');
    const button = screen.getByRole('button', { name: 'Configurações e perfil' });
    expect(button).toHaveTextContent('Pedro');
    expect(button.querySelector('svg')).not.toBeNull(); // the Settings gear
    fireEvent.click(button);
    expect(screen.getByTestId('where').textContent).toBe('/settings/profile');
  });

  it('the rail shows only the avatar, with the same destination', () => {
    mount('rail');
    const button = screen.getByRole('button', { name: 'Configurações e perfil' });
    expect(button).not.toHaveTextContent('Pedro');
    fireEvent.click(button);
    expect(screen.getByTestId('where').textContent).toBe('/settings/profile');
  });
});
