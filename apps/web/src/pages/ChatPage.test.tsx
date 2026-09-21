// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';
import type { ChatMessage } from '../lib/types';

const chatMock = vi.fn();
const sendMock = vi.fn();
const streamMock = vi.fn();

vi.mock('../lib/api', () => {
  // Same signature as the real one: the page shows `message`, so a stand-in that swallows it would
  // make the pt-BR server message untestable.
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
    api: { chat: (...a: unknown[]) => chatMock(...a), sendChatMessage: (...a: unknown[]) => sendMock(...a) },
  };
});
vi.mock('../lib/chat', () => ({ useChatStream: (...a: unknown[]) => streamMock(...a) }));

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  conversation_id: 'c1',
  role: 'user',
  text: '',
  error_code: null,
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  chatMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  chatMock.mockResolvedValue({ conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })] });
  sendMock.mockResolvedValue({ message: msg({ id: 'm3', role: 'assistant', text: 'pronto' }) });
  streamMock.mockReturnValue({ events: [], connected: true });
});

afterEach(() => cleanup());

it('shows the stored conversation', async () => {
  render(<ChatPage />);
  expect(await screen.findByText('oi')).toBeTruthy();
});

it('sends what was typed and clears the box', async () => {
  render(<ChatPage />);
  const box = await screen.findByPlaceholderText(/pergunte/i);
  fireEvent.change(box, { target: { value: 'o que está rodando?' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('o que está rodando?'));
  expect((box as HTMLTextAreaElement).value).toBe('');
});

it('re-reads the conversation whenever the socket (re)connects', async () => {
  // Review Focus 5: /ws/chat carries no history, so a reconnect mid-answer must refetch.
  streamMock.mockImplementation((onReconnect: () => void) => {
    onReconnect();
    return { events: [], connected: true };
  });
  render(<ChatPage />);
  await waitFor(() => expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2));
});

it('says when an answer did not finish', async () => {
  chatMock.mockResolvedValueOnce({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'assistant', text: 'comecei', error_code: 'RUNNER_FAILED' })],
  });
  render(<ChatPage />);
  expect(await screen.findByText(/não terminou/i)).toBeTruthy();
});

it('drops the delta trail from before a reset, keeping only what streamed after it', async () => {
  // The server retries a run on a fresh CLI session and throws away what streamed before the
  // reset; the bubble must never glue the abandoned half-answer to the real one.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  streamMock.mockReturnValue({
    events: [
      { type: 'delta', message_id: 'm2', delta: 'resposta abandonada' },
      { type: 'reset', message_id: 'm2' },
      { type: 'delta', message_id: 'm2', delta: 'resposta nova' },
    ],
    connected: true,
  });
  render(<ChatPage />);
  expect(await screen.findByText('resposta nova')).toBeTruthy();
  expect(screen.queryByText(/resposta abandonada/)).toBeNull();
});

it('does not wait for ever on an empty row left behind by a dead run', async () => {
  // A process death mid-run (every deploy has one) leaves an empty assistant row. Nothing will ever
  // fill it, so it must read as a failure instead of saying "pensando…" for the rest of time.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  render(<ChatPage />);
  expect(await screen.findByText(/não terminou/i)).toBeTruthy();
  expect(screen.queryByText(/pensando/i)).toBeNull();
});

it('says "pensando…" while the message it is answering is the live one', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  // The run was announced over the socket: this row is being written right now.
  streamMock.mockReturnValue({ events: [{ type: 'message', message: msg({ id: 'm2', role: 'assistant', text: '' }) }], connected: true });
  render(<ChatPage />);
  expect(await screen.findByText(/pensando/i)).toBeTruthy();
  expect(screen.queryByText(/não terminou/i)).toBeNull();
});

it('scrolls the list to the newest message when one arrives', async () => {
  // Past one viewport the user would otherwise send a message and see nothing move.
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { events: [], connected: true };
  });
  chatMock
    .mockResolvedValueOnce({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })] })
    .mockResolvedValue({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', role: 'assistant', text: 'pronto' })] });

  render(<ChatPage />);
  const list = await screen.findByRole('list');
  // jsdom lays nothing out, so the scrollable height is stubbed; what is asserted is that the page
  // pins the list to its bottom on new content.
  Object.defineProperty(list, 'scrollHeight', { value: 480, configurable: true });
  expect(list.scrollTop).toBe(0);

  deliver({ type: 'message', message: msg({ id: 'm2', role: 'assistant', text: 'pronto' }) });
  await waitFor(() => expect(list.scrollTop).toBe(480));
});

it('re-reads the conversation when sending fails, so no bubble is left waiting', async () => {
  // A 503 (the chat is not configured) deletes the empty assistant row the server had announced.
  const { ApiError } = await import('../lib/api');
  sendMock.mockRejectedValueOnce(new ApiError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED'));
  render(<ChatPage />);
  const box = await screen.findByPlaceholderText(/pergunte/i);
  fireEvent.change(box, { target: { value: 'oi' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

  expect(await screen.findByText(/não está configurado/i)).toBeTruthy();
  await waitFor(() => expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2));
});
