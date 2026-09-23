// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import type { ChatAction, ChatMessage } from '../../lib/types';

const chatMock = vi.fn();
const sendMock = vi.fn();
const streamMock = vi.fn();
const decideMock = vi.fn();
const setHostMock = vi.fn();
const machinesMock = vi.fn();
const accountsMock = vi.fn();
const resetMock = vi.fn();

vi.mock('../../lib/api', () => {
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
    api: {
      chat: (...a: unknown[]) => chatMock(...a),
      sendChatMessage: (...a: unknown[]) => sendMock(...a),
      decideChatAction: (...a: unknown[]) => decideMock(...a),
      setChatHost: (...a: unknown[]) => setHostMock(...a),
      resetChat: (...a: unknown[]) => resetMock(...a),
      machines: { list: (...a: unknown[]) => machinesMock(...a) },
      aiAccounts: { list: (...a: unknown[]) => accountsMock(...a) },
    },
  };
});
// The chat is the signed-in user's own, whoever an admin may be "viewing as": the panel needs that id
// to offer only machines `POST /chat/host` will accept, and needs to know when it is looking at
// someone else's rows. Held in a mutable box so one test can switch the scope without a second mock
// factory.
const auth = vi.hoisted(() => ({ state: { user: { id: 'u1' }, viewAs: null } as { user: { id: string } | null; viewAs: unknown } }));
vi.mock('../../lib/auth', () => ({ useAuth: () => auth.state }));
vi.mock('../../lib/chat', () => ({ useChatStream: (...a: unknown[]) => streamMock(...a) }));

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  conversation_id: 'c1',
  role: 'user',
  text: '',
  error_code: null,
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

const action = (over: Partial<ChatAction> & { id: string }): ChatAction => ({
  tool: 'send_input',
  args: { tab_id: 't1', text: 'npm test' },
  class: 'write',
  status: 'pending',
  machine_id: null,
  project_id: null,
  tab_id: 't1',
  summary: 'digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3',
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

/** A host that can run the conversation, reused across the tests below that don't care what it is. */
const READY = { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false };

beforeEach(() => {
  chatMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  decideMock.mockReset();
  setHostMock.mockReset();
  machinesMock.mockReset();
  accountsMock.mockReset();
  resetMock.mockReset();
  accountsMock.mockResolvedValue({ accounts: [] });
  auth.state = { user: { id: 'u1' }, viewAs: null };
  chatMock.mockResolvedValue({ conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })], actions: [] });
  sendMock.mockResolvedValue({ message: msg({ id: 'm3', role: 'assistant', text: 'pronto' }) });
  streamMock.mockReturnValue({ events: [], connected: true });
});

afterEach(() => cleanup());

it('loads the project conversation and sends into it', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  sendMock.mockResolvedValue({ message: { id: 'm2' } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalledWith('p1'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'status?' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledWith('status?', 'p1'));
});

it('ignores live events of another conversation', async () => {
  // load answers conversation c_p1; the stream mock hands us onEvent
  let onEvent!: (e: unknown) => void;
  streamMock.mockImplementation((_reload: unknown, cb: (e: unknown) => void) => {
    onEvent = cb;
    return { events: [{ type: 'delta', conversation_id: 'c_other', message_id: 'm9', delta: 'VAZOU' }], connected: true };
  });
  chatMock.mockResolvedValue({
    conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
    messages: [{ id: 'm9', conversation_id: 'c_p1', role: 'assistant', text: '', error_code: null, created_at: '' }],
    actions: [],
    host: READY,
  });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(chatMock).toHaveBeenCalled());
  expect(screen.queryByText('VAZOU')).toBeNull();
  onEvent({ type: 'confirmation', conversation_id: 'c_other', action_id: 'a9', tool: 'send_input', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'NÃO É DAQUI', created_at: '' });
  expect(screen.queryByText('NÃO É DAQUI')).toBeNull();
});

it('Nova conversa asks first, resets, and swaps in the empty conversation', async () => {
  chatMock
    .mockResolvedValueOnce({
      conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null },
      messages: [{ id: 'm1', conversation_id: 'c_p1', role: 'user', text: 'antigo', error_code: null, created_at: '' }],
      actions: [],
      host: READY,
    })
    .mockResolvedValue({ conversation: { id: 'c_new', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: READY });
  resetMock.mockResolvedValue({ conversation: { id: 'c_new', project_id: 'p1' } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  await screen.findByText('antigo');
  fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }));
  expect(resetMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Começar de novo' }));
  await waitFor(() => expect(resetMock).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(screen.queryByText('antigo')).toBeNull());
});

it('in a project, a host that is not chosen points to /chat instead of offering a picker', async () => {
  chatMock.mockResolvedValue({ conversation: { id: 'c_p1', project_id: 'p1', ai_account_id: null }, messages: [], actions: [], host: { kind: 'not_chosen', machines: [{ id: 'm1', name: 'a' }, { id: 'm2', name: 'b' }], sessionAtStake: false } });
  render(
    <MemoryRouter>
      <ChatPanel projectId="p1" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: /escolher a máquina do chat/i })).toHaveAttribute('href', '/chat');
});
