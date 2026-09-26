// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatMemoryPage } from './ChatMemoryPage';
import type { ChatDecision } from '../lib/types';

const chatMemoryMock = vi.fn();
const chatDecisionsMock = vi.fn();
const setChatMemoryMock = vi.fn();
const forgetChatDecisionMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      chatMemory: (...a: unknown[]) => chatMemoryMock(...a),
      chatDecisions: (...a: unknown[]) => chatDecisionsMock(...a),
      setChatMemory: (...a: unknown[]) => setChatMemoryMock(...a),
      forgetChatDecision: (...a: unknown[]) => forgetChatDecisionMock(...a),
    },
  };
});

const dec = (over: Partial<ChatDecision> & { id: string }): ChatDecision => ({
  project_id: 'p1',
  project_name: 'termhub',
  header: 'Worktree',
  question: 'Usar worktree?',
  options: [
    { label: 'Sim', description: '' },
    { label: 'Não', description: '' },
  ],
  multi_select: false,
  answer: { labels: ['Não'] },
  suggested_count: 2,
  accepted_count: 1,
  created_at: '2026-09-20T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  chatMemoryMock.mockReset();
  chatDecisionsMock.mockReset();
  setChatMemoryMock.mockReset();
  forgetChatDecisionMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('loads GET /memory and GET /decisions and lists question, answer, project, date and counts', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 1 });
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1' })], next_cursor: null });
  render(<ChatMemoryPage />);
  expect(await screen.findByText('Usar worktree?')).toBeInTheDocument();
  expect(screen.getByText('→ Não')).toBeInTheDocument();
  expect(screen.getByText(/termhub/)).toBeInTheDocument();
  expect(screen.getByText(/20\/09\/2026/)).toBeInTheDocument();
  expect(screen.getByText(/sugerida 2× · aceita 1×/)).toBeInTheDocument();
  expect(chatMemoryMock).toHaveBeenCalled();
  expect(chatDecisionsMock).toHaveBeenCalledWith(undefined);
});

it('shows a free-text answer as the text, not the labels', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 1 });
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1', answer: { labels: [], text: 'Usar branch' } })], next_cursor: null });
  render(<ChatMemoryPage />);
  expect(await screen.findByText('→ Usar branch')).toBeInTheDocument();
});

it('typing in "Buscar" re-queries with q, debounced', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  render(<ChatMemoryPage />);
  await screen.findByLabelText('Buscar');
  expect(chatDecisionsMock).toHaveBeenCalledTimes(1);

  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'worktree' } });
  expect(chatDecisionsMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300);
  expect(chatDecisionsMock).toHaveBeenCalledTimes(2);
  expect(chatDecisionsMock).toHaveBeenLastCalledWith('worktree');
});

it('"Esquecer" asks window.confirm and removes the row after the DELETE', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 1 });
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1' })], next_cursor: null });
  forgetChatDecisionMock.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ChatMemoryPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Esquecer' }));
  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => expect(forgetChatDecisionMock).toHaveBeenCalledWith('d1'));
  await waitFor(() => expect(screen.queryByText('Usar worktree?')).toBeNull());
});

it('the switch PATCHes { enabled: false }', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  setChatMemoryMock.mockResolvedValue({ enabled: false, available: true, count: 0 });
  render(<ChatMemoryPage />);
  fireEvent.click(await screen.findByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' }));
  expect(setChatMemoryMock).toHaveBeenCalledWith(false);
});

it('shows the unavailable note and hides the switch when available is false', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: false, available: false, count: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  render(<ChatMemoryPage />);
  expect(await screen.findByText('Sugestões indisponíveis neste servidor')).toBeInTheDocument();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('"Carregar mais" appears with next_cursor and appends the next page', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 2 });
  chatDecisionsMock.mockResolvedValueOnce({ decisions: [dec({ id: 'd1' })], next_cursor: 'c2' });
  chatDecisionsMock.mockResolvedValueOnce({ decisions: [dec({ id: 'd2', question: 'Outra pergunta?' })], next_cursor: null });
  render(<ChatMemoryPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
  expect(await screen.findByText('Outra pergunta?')).toBeInTheDocument();
  expect(screen.getByText('Usar worktree?')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  expect(chatDecisionsMock).toHaveBeenLastCalledWith(undefined, 'c2');
});
