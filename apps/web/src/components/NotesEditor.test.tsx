// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesEditor } from './NotesEditor';
import type { Note } from '../lib/types';

const getMock = vi.fn();
const saveMock = vi.fn();

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
      notes: {
        get: (...a: unknown[]) => getMock(...a),
        save: (...a: unknown[]) => saveMock(...a),
      },
    },
  };
});

const note = (over: Partial<Note> = {}): Note => ({
  id: 'n1',
  project_id: 'p1',
  content: 'texto inicial',
  updated_at: '2026-09-20T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  getMock.mockReset();
  saveMock.mockReset();
  localStorage.clear();
  // Every test edits the textarea without necessarily letting the debounced save land, so `cleanup()`
  // below always finds a dirty draft and runs the keep-alive `flush()` on unmount — stub `fetch` for
  // every test (not only the one that asserts on it) so that never reaches the real network.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(undefined));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('loads the note and, after the debounce, saves sending base_updated_at', async () => {
  getMock.mockResolvedValue({ note: note() });
  saveMock.mockResolvedValue({ note: note({ content: 'texto editado', updated_at: '2026-09-20T10:01:00.000Z' }) });
  render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByDisplayValue('texto inicial');

  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'texto editado' } });
  expect(saveMock).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();
  await waitFor(() => expect(saveMock).toHaveBeenCalledWith('p1', 'texto editado', '2026-09-20T10:00:00.000Z'));
});

it('an ordinary save (server content matches what was sent) shows "salvo" and keeps the typed text', async () => {
  getMock.mockResolvedValue({ note: note() });
  saveMock.mockResolvedValue({ note: note({ content: 'texto editado', updated_at: '2026-09-20T10:01:00.000Z' }) });
  render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByDisplayValue('texto inicial');

  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'texto editado' } });
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();

  await waitFor(() => expect(screen.getByText(/^salvo/)).toBeInTheDocument());
  expect((textarea as HTMLTextAreaElement).value).toBe('texto editado');
});

it('adopts the server content and shows the agent-lesson notice when nothing was typed since the save started', async () => {
  getMock.mockResolvedValue({ note: note() });
  let resolveSave!: (v: { note: Note }) => void;
  saveMock.mockImplementationOnce(() => new Promise((resolve) => (resolveSave = resolve)));
  render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByDisplayValue('texto inicial');

  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'texto editado' } });
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();
  await waitFor(() => expect(saveMock).toHaveBeenCalled());

  const merged = 'texto editado\n\n## Lições\n\nbloco adicionado pelo agente';
  await act(async () => resolveSave({ note: note({ content: merged, updated_at: '2026-09-20T10:05:00.000Z' }) }));

  expect(await screen.findByDisplayValue(merged, { normalizer: (s) => s })).toBeInTheDocument();
  expect(screen.getByText(/lição adicionada por um agente/)).toBeInTheDocument();
});

it("keeps the person's text when they typed again before the save resolved with different content", async () => {
  getMock.mockResolvedValue({ note: note() });
  let resolveSave!: (v: { note: Note }) => void;
  saveMock.mockImplementationOnce(() => new Promise((resolve) => (resolveSave = resolve)));
  render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByDisplayValue('texto inicial');

  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'texto editado' } });
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();
  await waitFor(() => expect(saveMock).toHaveBeenCalled());

  // The person keeps typing while the request started from "texto editado" is still in flight.
  fireEvent.change(textarea, { target: { value: 'texto editado e mais um pouco' } });

  const merged = 'texto editado\n\n## Lições\n\nbloco adicionado pelo agente';
  await act(async () => resolveSave({ note: note({ content: merged, updated_at: '2026-09-20T10:05:00.000Z' }) }));

  expect((textarea as HTMLTextAreaElement).value).toBe('texto editado e mais um pouco');
  expect(screen.queryByText(/lição adicionada por um agente/)).toBeNull();
});

it('the keep-alive save on unload also sends base_updated_at', async () => {
  getMock.mockResolvedValue({ note: note() });
  const fetchMock = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
  const { unmount } = render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByDisplayValue('texto inicial');

  fireEvent.change(textarea, { target: { value: 'texto editado' } });
  unmount();

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/projects/p1/note',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ content: 'texto editado', base_updated_at: '2026-09-20T10:00:00.000Z' }),
    }),
  );
});
