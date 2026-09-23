// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ can: (() => true) as (resource: string, action?: string) => boolean, needsYou: [] as unknown[] }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: state.can }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ needsYou: state.needsYou }) }));

import { MainNav } from './MainNav';

const mount = (variant: 'list' | 'rail') =>
  render(
    <MemoryRouter>
      <MainNav variant={variant} />
    </MemoryRouter>,
  );

beforeEach(() => {
  state.can = () => true;
  state.needsYou = [];
});
afterEach(cleanup);

describe('MainNav', () => {
  it('lists Escritório, Chat and Máquinas, in that order, with icons', () => {
    mount('list');
    const links = within(screen.getByRole('navigation', { name: 'Menu principal' })).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Escritório', '/office'],
      ['Chat', '/chat'],
      ['Máquinas', '/machines'],
    ]);
    for (const l of links) expect(l.querySelector('svg')).not.toBeNull();
  });

  it('shows each menu only under its permission', () => {
    // projects:read without terminals:read is not enough for Escritório; no chat grant
    state.can = (r, a) => r === 'machines' || (r === 'projects' && a === 'read');
    mount('list');
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Máquinas']);
  });

  it('renders nothing when no menu is allowed', () => {
    state.can = () => false;
    const { container } = mount('list');
    expect(container).toBeEmptyDOMElement();
  });

  it('puts the attention dot on Escritório when someone needs you', () => {
    mount('list');
    expect(screen.queryByLabelText('alguém precisa de você')).toBeNull();
    cleanup();
    state.needsYou = [{}];
    mount('list');
    expect(within(screen.getByRole('link', { name: /Escritório/ })).getByLabelText('alguém precisa de você')).toBeInTheDocument();
  });

  it('in the rail, shows icons named and titled by their label, the dot in the name', () => {
    state.needsYou = [{}];
    mount('rail');
    const office = screen.getByRole('link', { name: 'Escritório, alguém precisa de você' });
    expect(office).toHaveAttribute('title', 'Escritório');
    expect(screen.getByRole('link', { name: 'Chat' }).textContent).toBe('');
    expect(screen.getByRole('link', { name: 'Máquinas' })).toHaveAttribute('href', '/machines');
  });
});
