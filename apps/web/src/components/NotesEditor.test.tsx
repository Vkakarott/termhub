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

it('a project with no note yet (id \'\') still sends the epoch as base_updated_at, so a concierge append survives', async () => {
  const epoch = new Date(0).toISOString();
  getMock.mockResolvedValue({ note: note({ id: '', content: '', updated_at: epoch }) });
  saveMock.mockResolvedValue({ note: note({ content: 'primeira linha', updated_at: '2026-09-20T10:01:00.000Z' }) });
  render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByPlaceholderText(/Notas do projeto/);

  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'primeira linha' } });
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();
  await waitFor(() => expect(saveMock).toHaveBeenCalled());
  expect(saveMock.mock.calls[0]).toEqual(['p1', 'primeira linha', epoch]);
  // The epoch is a merge base, never a date to show: no "31/12/1969" in the status line.
  expect(screen.queryByText(/1969|1970/)).toBeNull();
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

it("when the response content matches what was sent, the NEXT save carries the response's updated_at as the new base", async () => {
  getMock.mockResolvedValue({ note: note() });
  saveMock.mockResolvedValueOnce({ note: note({ content: 'texto editado', updated_at: '2026-09-20T10:01:00.000Z' }) });
  render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByDisplayValue('texto inicial');

  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'texto editado' } });
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();
  await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  expect(saveMock).toHaveBeenLastCalledWith('p1', 'texto editado', '2026-09-20T10:00:00.000Z');

  saveMock.mockResolvedValueOnce({ note: note({ content: 'mais texto', updated_at: '2026-09-20T10:02:00.000Z' }) });
  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'mais texto' } });
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();

  await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
  expect(saveMock).toHaveBeenLastCalledWith('p1', 'mais texto', '2026-09-20T10:01:00.000Z');
});

it("after adopting a merged response (nothing typed since), the NEXT save carries the response's updated_at as the new base", async () => {
  getMock.mockResolvedValue({ note: note() });
  let resolveSave!: (v: { note: Note }) => void;
  saveMock.mockImplementationOnce(() => new Promise((resolve) => (resolveSave = resolve)));
  render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByDisplayValue('texto inicial');

  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'texto editado' } });
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();
  await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));

  const merged = 'texto editado\n\n## Lições\n\nbloco adicionado pelo agente';
  await act(async () => resolveSave({ note: note({ content: merged, updated_at: '2026-09-20T10:05:00.000Z' }) }));
  expect(await screen.findByDisplayValue(merged, { normalizer: (s) => s })).toBeInTheDocument();

  // The person types again only after the adoption landed — a plain, uncontested next edit.
  saveMock.mockResolvedValueOnce({ note: note({ content: 'mais uma edição', updated_at: '2026-09-20T10:06:00.000Z' }) });
  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'mais uma edição' } });
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();

  await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
  expect(saveMock).toHaveBeenLastCalledWith('p1', 'mais uma edição', '2026-09-20T10:05:00.000Z');
});

it("after the typed-since race (merge response differs, person kept typing), the NEXT save carries the ORIGINAL base — not the response's updated_at", async () => {
  getMock.mockResolvedValue({ note: note() });
  let resolveSave!: (v: { note: Note }) => void;
  saveMock.mockImplementationOnce(() => new Promise((resolve) => (resolveSave = resolve)));
  render(<NotesEditor projectId="p1" />);
  const textarea = await screen.findByDisplayValue('texto inicial');

  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'texto editado' } }); // base sent with this request: T0
  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();
  await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  expect(saveMock).toHaveBeenLastCalledWith('p1', 'texto editado', '2026-09-20T10:00:00.000Z');

  // The person keeps typing while that request (base T0) is still in flight.
  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: 'texto editado e mais um pouco' } });

  saveMock.mockResolvedValueOnce({ note: note({ content: 'texto editado e mais um pouco', updated_at: '2026-09-20T10:02:00.000Z' }) });
  const merged = 'texto editado\n\n## Lições\n\nbloco adicionado pelo agente';
  // The in-flight request resolves with a row the submission does not fully carry (it grew a lesson
  // block, updated_at T3) — since the person typed since, the editor must not adopt it, and must not
  // advance `base` to T3 either (T3's row already has the block; sending T3 back would make the
  // server's merge think the block is already known and drop it for good).
  await act(async () => resolveSave({ note: note({ content: merged, updated_at: '2026-09-20T10:05:00.000Z' }) }));
  expect((textarea as HTMLTextAreaElement).value).toBe('texto editado e mais um pouco');

  await vi.advanceTimersByTimeAsync(800);
  vi.useRealTimers();

  await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
  expect(saveMock).toHaveBeenLastCalledWith('p1', 'texto editado e mais um pouco', '2026-09-20T10:00:00.000Z');
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
