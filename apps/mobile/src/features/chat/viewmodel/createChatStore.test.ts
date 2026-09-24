// The chat store (design spec §6) over the real `HttpMobileApi`, the in-memory `MockTransport`
// and its fake socket, with an enrolled, unlocked session store built over the same mock.
import * as SecureStore from 'expo-secure-store';
import type { TChatEvent } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { mmkv } from '@/services/storage';
import { foldLive } from '../model/live';
import { createChatStore } from './createChatStore';
import { enrol, PIN, setupSession } from '../../../../test/helpers/enrolled-session';

const secureItems = (SecureStore as unknown as { __items: Map<string, string> }).__items;
// Captured before any test installs fake timers: drains every pending microtask (a `void`-started wipe).
const realSetImmediate = setImmediate;
const flush = () => new Promise<void>((resolve) => realSetImmediate(() => resolve()));

type ChatStore = ReturnType<typeof createChatStore>;
type Handlers = Parameters<ReturnType<typeof setupSession>['api']['events']>[1];

const opened: ChatStore[] = [];

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  // Call-through spy: the real socket stays, the test also gets the handlers the store registered.
  const events = jest.spyOn(ctx.api, 'events');
  const chat = createChatStore({ api: ctx.api, session: () => ctx.store.getState() });
  opened.push(chat);
  const handlers = (): Handlers => events.mock.calls[0]![1];
  return { ...ctx, chat, events, handlers };
}

/** Opens a conversation and lets the fake socket connect (its `hello` is on a 0 ms timer). */
async function openAndConnect(chat: ChatStore, projectId: string | null) {
  await chat.getState().open(projectId);
  await jest.advanceTimersByTimeAsync(0);
  expect(chat.getState().connected).toBe(true);
}

const slot = (chat: ChatStore, projectId: string | null) => chat.getState().conversations[projectId ?? '']!;

function decision(conversationId: string, actionId: string, status: 'approved' | 'denied'): TChatEvent {
  return { type: 'decision', user_id: 'u1', conversation_id: conversationId, action_id: actionId, status };
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
  secureItems.clear();
});

afterEach(() => {
  while (opened.length) opened.pop()!.getState().close();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('loadProjects fills the three projects', async () => {
  const { chat } = await setup();
  await chat.getState().loadProjects();
  const { projects, loadingProjects } = chat.getState();
  expect(projects.map((p) => p.id).sort()).toEqual(['p-opapingou', 'p-reactivando', 'p-termhub']);
  expect(projects.find((p) => p.id === 'p-termhub')!.pending_confirmations).toBe(1);
  expect(loadingProjects).toBe(false);
});

it("open('p-termhub') loads the thread and subscribes once for the whole app", async () => {
  const { chat, events } = await setup();
  await openAndConnect(chat, 'p-termhub');

  const s = slot(chat, 'p-termhub');
  expect(s).toMatchObject({ loaded: true, error: null, conversation: { id: 'c-termhub', project_id: 'p-termhub' } });
  expect(s.messages).toHaveLength(4);
  expect(s.actions).toEqual([expect.objectContaining({ id: 'a-termhub-1', status: 'pending' })]);
  expect(s.host).toMatchObject({ kind: 'ready', machine: { name: 'jarvis' } });
  expect(chat.getState().activeProject).toBe('p-termhub');

  await chat.getState().open(null);
  expect(slot(chat, null).conversation?.id).toBe('c-general');
  expect(chat.getState().activeProject).toBeNull();
  expect(events).toHaveBeenCalledTimes(1);
});

it('a reconnect re-reads the conversation and empties live', async () => {
  const { chat, api, controls, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: 'meio' });
  expect(chat.getState().live).toHaveLength(1);

  const read = jest.spyOn(api, 'chat');
  controls.dropSocket();
  expect(chat.getState().connected).toBe(false);

  await jest.advanceTimersByTimeAsync(2000); // the socket's first backoff step (1 s), then its connect tick
  expect(chat.getState().connected).toBe(true);
  expect(read).toHaveBeenCalledWith(expect.anything(), 'p-termhub');
  expect(chat.getState().live).toEqual([]);
});

it('send answers at once and the thread grows only through events; deltas fold into foldLive(live)', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const read = jest.spyOn(api, 'chat');
  const sent = jest.spyOn(api, 'sendMessage');

  await expect(chat.getState().send('  roda o teste  ')).resolves.toBe(true);
  expect(sent).toHaveBeenCalledWith(expect.anything(), { text: 'roda o teste', project_id: 'p-termhub' });
  expect(chat.getState().sending).toBe(false);
  expect(slot(chat, 'p-termhub').messages).toHaveLength(4); // nothing appended locally
  const { assistant_message_id: assistantId } = await sent.mock.results[0]!.value;

  await jest.advanceTimersToNextTimerAsync(); // the user's row
  expect(slot(chat, 'p-termhub').messages).toHaveLength(5);
  expect(read).toHaveBeenCalledTimes(1); // a `message` event re-reads the thread

  await jest.advanceTimersToNextTimerAsync(); // the empty assistant row: "pensando…"
  expect(slot(chat, 'p-termhub').messages).toHaveLength(6);
  expect(foldLive(chat.getState().live).started.has(assistantId)).toBe(true);

  await jest.advanceTimersToNextTimerAsync();
  await jest.advanceTimersToNextTimerAsync();
  const streaming = foldLive(chat.getState().live).deltas.get(assistantId);
  expect(streaming).toBeTruthy();

  await jest.advanceTimersByTimeAsync(5000);
  const final = slot(chat, 'p-termhub').messages.find((m) => m.id === assistantId)!;
  expect(final.text).toBe('Rodei `npm test` no jarvis: 1066 testes passaram, 137 pulados. Nada quebrou.');
  expect(final.text.startsWith(streaming!)).toBe(true);
  expect(foldLive(chat.getState().live).deltas.has(assistantId)).toBe(false);
  expect(chat.getState().live).toEqual([]);
});

it('a 409 CHAT_BUSY says the chat is still answering; other errors show their own text', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const sent = jest.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError(409, 'CHAT_BUSY', 'ocupado'));

  await expect(chat.getState().send('oi')).resolves.toBe(false);
  expect(chat.getState()).toMatchObject({ sending: false, error: 'O chat ainda está respondendo. Aguarde.' });

  sent.mockRejectedValueOnce(new ApiError(409, 'HOST_OFFLINE', 'A máquina do chat está offline.'));
  await chat.getState().send('oi');
  expect(chat.getState().error).toBe('A máquina do chat está offline.');
});

it("decide(id, 'approve') asks requestPinProof(id) and, once resolved, the card is approved", async () => {
  const { chat, store } = await setup();
  await openAndConnect(chat, 'p-termhub');

  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1' });
  expect(chat.getState().decidingId).toBe('a-termhub-1');

  await store.getState().resolvePinPrompt(PIN);
  await deciding;
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('approved');
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it('decide never moves a card backwards: a re-read that already says executed wins over the late HTTP answer', async () => {
  const { chat, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const realDecide = api.decide.bind(api);
  jest.spyOn(api, 'decide').mockImplementation(async (auth, id, body) => {
    await realDecide(auth, id, body);
    // A re-read lands before the slow HTTP answer: the action already ran.
    const state = chat.getState();
    const slotNow = state.conversations['p-termhub']!;
    chat.setState({
      conversations: { ...state.conversations, 'p-termhub': { ...slotNow, actions: slotNow.actions.map((a) => ({ ...a, status: 'executed' as const })) } },
    });
  });

  await chat.getState().decide('a-termhub-1', 'deny');
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('executed');
});

it('a cancelled PIN prompt leaves the card pending and shows nothing', async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const decide = jest.spyOn(api, 'decide');

  const deciding = chat.getState().decide('a-termhub-1', 'approve');
  store.getState().cancelPinPrompt();
  await deciding;
  expect(decide).not.toHaveBeenCalled();
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('pending');
  expect(chat.getState()).toMatchObject({ decidingId: null, error: null });
});

it('a decision event updates the card by id and is idempotent; a repeated confirmation adds one card', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');

  handlers().onEvent(decision('c-termhub', 'a-termhub-1', 'approved'));
  handlers().onEvent(decision('c-termhub', 'a-termhub-1', 'approved'));
  expect(slot(chat, 'p-termhub').actions).toEqual([expect.objectContaining({ id: 'a-termhub-1', status: 'approved' })]);

  const confirmation: TChatEvent = {
    type: 'confirmation',
    user_id: 'u1',
    conversation_id: 'c-termhub',
    action_id: 'a-new',
    tool: 'send_input',
    args: {},
    class: 'write',
    machine_id: 'm-jarvis',
    project_id: 'p-termhub',
    tab_id: 't-api',
    summary: 'digitar comando na aba api',
    created_at: new Date().toISOString(),
  };
  handlers().onEvent(confirmation);
  handlers().onEvent(confirmation);
  const actions = slot(chat, 'p-termhub').actions;
  expect(actions.filter((a) => a.id === 'a-new')).toEqual([expect.objectContaining({ status: 'pending', summary: 'digitar comando na aba api' })]);
});

it("decide(id, 'deny') needs no prompt; deciding it again is a 409 that says so", async () => {
  const { chat, store, api } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const decide = jest.spyOn(api, 'decide');
  const challenge = jest.spyOn(api, 'challenge');

  await chat.getState().decide('a-termhub-1', 'deny');
  expect(decide).toHaveBeenCalledWith(expect.anything(), 'a-termhub-1', { decision: 'deny' });
  expect(challenge).not.toHaveBeenCalled();
  expect(store.getState().pinPrompt).toBeNull();
  expect(slot(chat, 'p-termhub').actions[0]!.status).toBe('denied');

  await chat.getState().decide('a-termhub-1', 'deny');
  expect(chat.getState()).toMatchObject({ decidingId: null, error: 'Essa ação já foi decidida.' });
});

it('events of another conversation never touch the open one', async () => {
  const { chat, api, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  const before = slot(chat, 'p-termhub');
  const read = jest.spyOn(api, 'chat');

  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-opapingou', message_id: 'm1', delta: 'x' });
  handlers().onEvent(decision('c-opapingou', 'a-termhub-1', 'denied'));
  handlers().onEvent({
    type: 'message',
    user_id: 'u1',
    conversation_id: 'c-opapingou',
    message: { id: 'm2', conversation_id: 'c-opapingou', role: 'user', text: 'oi', usage: null, error_code: null, created_at: new Date().toISOString() },
  });

  expect(chat.getState().live).toEqual([]);
  expect(slot(chat, 'p-termhub')).toBe(before);
  expect(read).not.toHaveBeenCalled();
});

it('reset empties the thread on a new conversation', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, 'p-termhub');
  await chat.getState().reset();
  const s = slot(chat, 'p-termhub');
  expect(s.messages).toEqual([]);
  expect(s.conversation?.id).not.toBe('c-termhub');
});

it('openByRoute resolves a conversation id, a project id and general; anything else opens the account-wide chat with an error', async () => {
  const { chat } = await setup();
  await chat.getState().loadProjects();
  await chat.getState().openByRoute('p-opapingou');
  expect(chat.getState().activeProject).toBe('p-opapingou');

  await chat.getState().openByRoute('general');
  expect(chat.getState()).toMatchObject({ activeProject: null, error: null });

  await chat.getState().openByRoute('c-opapingou'); // loaded above: a known conversation id
  expect(chat.getState().conversationIdToProject('c-opapingou')).toBe('p-opapingou');
  expect(chat.getState().activeProject).toBe('p-opapingou');

  await chat.getState().openByRoute('c-nowhere');
  expect(chat.getState()).toMatchObject({ activeProject: null, error: 'Conversa não encontrada.' });
});

it('loadHostOptions lists the machines and setHost re-reads the account-wide chat', async () => {
  const { chat } = await setup();
  await openAndConnect(chat, null);
  await chat.getState().loadHostOptions();
  expect(chat.getState().hostOptions?.machines.map((m) => m.name)).toEqual(['jarvis', 'hulk']);

  await chat.getState().setHost('m-hulk');
  expect(slot(chat, null).host).toEqual({ kind: 'offline', machine: { id: 'm-hulk', name: 'hulk' } });
  await chat.getState().setHost('m-jarvis', 'acc-1');
  expect(slot(chat, null).host).toMatchObject({ kind: 'ready', account: { kind: 'chosen', label: 'Claude Pedro' } });
});

it('a 4400 close asks to update the app', async () => {
  const { chat, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  handlers().onClose(4400, true);
  expect(chat.getState()).toMatchObject({ connected: false, error: 'Atualize o app para continuar.' });
});

it('a 1008 close only marks the socket disconnected: the session is not wiped', async () => {
  const { chat, store, handlers } = await setup();
  await openAndConnect(chat, 'p-termhub');
  handlers().onClose(1008, false);
  await flush();
  expect(chat.getState()).toMatchObject({ connected: false, error: null, activeProject: 'p-termhub' });
  expect(store.getState().phase).toBe('unlocked');
});

it('a 4401 close wipes the session, and sessionEnded resets the store and closes the socket', async () => {
  const { chat, store, controls } = await setup();
  await chat.getState().loadProjects();
  await openAndConnect(chat, 'p-termhub');

  controls.revokeNow();
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  expect(store.getState().phase).toBe('new');
  expect(chat.getState()).toMatchObject({ projects: [], conversations: {}, live: [], connected: false, activeProject: undefined });
});

it('persists projects and each conversation, never live or transient state', async () => {
  const { chat, api, handlers } = await setup();
  await chat.getState().loadProjects();
  await openAndConnect(chat, 'p-termhub');
  handlers().onEvent({ type: 'delta', user_id: 'u1', conversation_id: 'c-termhub', message_id: 'm-x', delta: 'meio' });

  const saved = JSON.parse(mmkv.getString('chat')!).state;
  expect(Object.keys(saved).sort()).toEqual(['conversations', 'projects']);
  expect(Object.keys(saved.conversations['p-termhub']).sort()).toEqual(['actions', 'conversation', 'host', 'messages']);

  // A cold start shows the thread before any fetch.
  const again = createChatStore({ api, session: () => ({ phase: 'locked', auth: () => { throw new Error('LOCKED'); }, handleApiError: () => false, requestPinProof: async () => { throw new Error('CANCELLED'); } }) });
  opened.push(again);
  expect(again.getState().projects).toHaveLength(3);
  expect(slot(again, 'p-termhub')).toMatchObject({ loaded: false, error: null, conversation: { id: 'c-termhub' } });
  expect(slot(again, 'p-termhub').messages).toHaveLength(4);
  expect(again.getState().live).toEqual([]);
});
