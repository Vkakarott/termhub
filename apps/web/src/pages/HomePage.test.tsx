// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ statuses: {}, projects: [] }) }));
vi.mock('../lib/api', () => ({ api: { dashboard: () => new Promise(() => {}) } }));
vi.mock('../components/NeedsYouList', () => ({ NeedsYouList: () => null }));
vi.mock('../components/ProjectCards', () => ({ ProjectCards: () => null }));

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
  it('is the projects dashboard under the shared header, with no tabs', () => {
    mount('/');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Início']);
    expect(screen.queryByRole('navigation', { name: 'Seções de Início' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'O que estou fazendo' })).toBeInTheDocument();
  });
});
