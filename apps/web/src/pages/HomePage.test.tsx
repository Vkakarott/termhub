// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: (r: string) => r !== 'waitlist' }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ statuses: {}, projects: [] }) }));
vi.mock('../lib/api', () => ({ api: { dashboard: () => new Promise(() => {}) } }));
vi.mock('../components/NeedsYouList', () => ({ NeedsYouList: () => null }));
vi.mock('../components/ProjectCards', () => ({ ProjectCards: () => null }));
vi.mock('../components/AiAccountsView', () => ({ AiAccountsView: () => <p>ai-view</p> }));
vi.mock('../components/HardwareView', () => ({ HardwareView: () => <p>hardware-view</p> }));
vi.mock('../components/WaitlistView', () => ({ WaitlistView: () => <p>waitlist-view</p> }));

import { HomePage } from './HomePage';

function mount(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<HomePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('HomePage', () => {
  it('uses the shared page header with its tabs, under their permissions', () => {
    mount('/');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Início']);
    const tabs = within(screen.getByRole('navigation', { name: 'Seções de Início' })).getAllByRole('link');
    expect(tabs.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Projetos', '/'],
      ['Contas de IA', '/ai'],
      ['Hardware', '/hardware'],
    ]);
    expect(screen.getByRole('heading', { level: 2, name: 'O que estou fazendo' })).toBeInTheDocument();
  });

  it('marks and opens the current tab', () => {
    mount('/ai');
    expect(screen.getByRole('link', { name: 'Contas de IA' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Projetos' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('ai-view')).toBeInTheDocument();
  });
});
