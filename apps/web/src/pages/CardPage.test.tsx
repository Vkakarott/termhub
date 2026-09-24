// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const byRefMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { tasks: { byRef: (...a: unknown[]) => byRefMock(...a) } } };
});
vi.mock('./ProjectPage', () => ({
  ProjectPage: ({ card }: { card?: { projectId: string; taskId: string } }) => (
    <div>
      board {card?.projectId} {card?.taskId}
    </div>
  ),
}));

import { ApiError } from '../lib/api';
import { CardPage } from './CardPage';

function mount(ref: string) {
  render(
    <MemoryRouter initialEntries={[`/project/${ref}`]}>
      <Routes>
        <Route path="/project/:ref" element={<CardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CardPage', () => {
  it('resolves the ref and shows the project board with that card open', async () => {
    byRefMock.mockResolvedValue({ task: { id: 'k12', parent_id: null }, project_id: 'p1' });
    mount('ter-12');
    expect(await screen.findByText('board p1 k12')).toBeInTheDocument();
    expect(byRefMock).toHaveBeenCalledWith('ter-12');
  });

  it('opens the parent of a subtask', async () => {
    byRefMock.mockResolvedValue({ task: { id: 's1', parent_id: 'k12' }, project_id: 'p1' });
    mount('TER-13');
    expect(await screen.findByText('board p1 k12')).toBeInTheDocument();
  });

  it('says "Card não encontrado" for an unknown ref or one outside the scope', async () => {
    byRefMock.mockRejectedValue(new ApiError(404, 'Card não encontrado'));
    mount('TER-99');
    expect(await screen.findByText('Card não encontrado')).toBeInTheDocument();
  });

  it('says so when the lookup fails for another reason', async () => {
    byRefMock.mockRejectedValue(new ApiError(500, 'Erro interno'));
    mount('TER-1');
    expect(await screen.findByText('Erro ao abrir o card')).toBeInTheDocument();
  });
});
