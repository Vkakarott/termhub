// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: { integrations: { list: () => Promise.resolve({ integrations: [] }) } },
}));

import { IntegrationsView } from './IntegrationsView';

const mount = () =>
  render(
    <MemoryRouter>
      <IntegrationsView />
    </MemoryRouter>,
  );

afterEach(cleanup);

describe('IntegrationsView', () => {
  it('sits under the shared header, "+ integração" among its actions and the explanation in the content', async () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Integrações']);
    expect(screen.getByRole('button', { name: '+ integração' }).closest('header')).not.toBeNull();
    expect(screen.getByText(/Credenciais de GitHub, Linear e Jira/).closest('header')).toBeNull();
    expect(await screen.findByText('Nenhuma integração ainda.')).toBeInTheDocument();
  });

  it('"+ integração" opens the form', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '+ integração' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
