// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';
import type { ChatMessage } from '../lib/types';

const chatMock = vi.fn();
const sendMock = vi.fn();
const streamMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
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
