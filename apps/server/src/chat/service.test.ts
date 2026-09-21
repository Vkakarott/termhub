import { beforeEach, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import { chatBus, type ChatEvent } from './bus.js';
import { HttpError } from '../lib/errors.js';
import { ChatService, type RunnerClient } from './service.js';

const user = { id: 'u1', email: 'p@test', role_id: 'role_authenticated' } as unknown as User;

const action = (overrides: Partial<ChatAction> = {}): ChatAction => ({
  id: 'a1',
  conversation_id: 'c1',
  message_id: null,
  tool: 'send_input',
  args: { tab_id: 't1', text: 'npm test' },
  class: 'write',
  status: 'approved',
  idempotency_key: 'k1',
  machine_id: null,
  project_id: null,
  tab_id: 't1',
  error_code: null,
  duration_ms: null,
  decided_by: 'u1',
  decided_at: '2026-09-21T12:00:00.000Z',
  injected_at: null,
  created_at: '2026-09-21T11:59:00.000Z',
  ...overrides,
});

function build(lines: string[] | (() => AsyncIterable<string>), opts: { chatActions?: ChatAction[] } = {}) {
  const conversation = { id: 'c1', user_id: 'u1', title: null, cli_session_id: null, model: null, review_mode: false, last_message_at: null, created_at: '' };
  const messages: { id: string; role: string; text: string; error_code: string | null }[] = [];
  const chat = {
    getOrCreateForUser: vi.fn(async () => conversation),
    setCliSession: vi.fn(async (_id: string, s: string | null) => void (conversation.cli_session_id = s)),
    addMessage: vi.fn(async (m: { role: string; text: string }) => {
      const row = { id: `m${messages.length + 1}`, role: m.role, text: m.text, error_code: null };
      messages.push(row);
      return row;
    }),
    updateMessage: vi.fn(async (id: string, patch: { text?: string; error_code?: string | null }) => {
      const row = messages.find((m) => m.id === id)!;
      if (patch.text !== undefined) row.text = patch.text;
      if (patch.error_code !== undefined) row.error_code = patch.error_code;
      return row;
    }),
    deleteMessage: vi.fn(async (id: string) => {
      const i = messages.findIndex((m) => m.id === id);
      if (i >= 0) messages.splice(i, 1);
    }),
    listMessages: vi.fn(async () => messages),
  };
  // An in-memory stand-in for the two chatActions reads/writes ChatService now uses, real enough to
  // exercise the queue: findNextToInject only ever sees a decided (approved/denied) row nobody has
  // marked injected, oldest decided_at first, exactly like the repository's own ordering.
  const actionsStore: ChatAction[] = opts.chatActions ? opts.chatActions.map((a) => ({ ...a })) : [];
  const chatActions = {
    markInjected: vi.fn(async (id: string) => {
      const row = actionsStore.find((a) => a.id === id);
      if (row) row.injected_at = new Date().toISOString();
    }),
    findNextToInject: vi.fn(async (conversationId: string) => {
      const open = actionsStore
        .filter((a) => a.conversation_id === conversationId && (a.status === 'approved' || a.status === 'denied') && a.injected_at === null)
        .sort((a, b) => Date.parse(a.decided_at ?? a.created_at) - Date.parse(b.decided_at ?? b.created_at));
      return open[0];
    }),
  };
  const repos = {
    chat,
    apiTokens: { listByUser: vi.fn(async () => []), create: vi.fn(async () => ({})), revoke: vi.fn(async () => undefined) },
    chatActions,
  } as unknown as Repositories;
  const runner: RunnerClient = {
    run: vi.fn(() => (typeof lines === 'function' ? lines() : (async function* () { for (const l of lines) yield l; })())),
  };
  return { service: new ChatService({ repos, runner, configDirs: { primary: '/accounts/primary' } }), chat, chatActions, actionsStore, runner, messages, conversation, repos };
}

const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const done = (session = '3f1e9b1e-0000-4000-8000-000000000001') => JSON.stringify({ type: 'result', session_id: session, usage: { input_tokens: 5 } });
/** Exactly what the container writes when the CLI exits non-zero: a code and a classified reason,
 * never stderr's text (see apps/concierge/src/index.ts). */
const errorFrame = (reason: 'missing_session' | 'run_failed') => JSON.stringify({ type: 'termhub_error', code: 1, reason });

beforeEach(() => vi.clearAllMocks());

it('stores the question, the answer, and the session id the CLI reports', async () => {
  const { service, chat, messages, conversation } = build([delta('Nada '), delta('rodando.'), done()]);
  const answer = await service.send(user, 'o que está rodando?');

  expect(messages.map((m) => [m.role, m.text])).toEqual([
    ['user', 'o que está rodando?'],
    ['assistant', 'Nada rodando.'],
  ]);
  expect(answer.text).toBe('Nada rodando.');
  expect(conversation.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-000000000001');
  expect(chat.setCliSession).toHaveBeenCalled();
});

it('resumes the session on the next message', async () => {
  const { service, runner, conversation } = build([delta('ok'), done()]);
  conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000001';
  await service.send(user, 'e agora?');
  expect(vi.mocked(runner.run).mock.calls[0][0]).toMatchObject({ resume: true, session_id: '3f1e9b1e-0000-4000-8000-000000000001' });
});

it('refuses a second message while one is still being answered', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { service } = build(() => (async function* () { await gate; yield delta('ok'); yield done(); })());

  const first = service.send(user, 'primeira');
  await expect(service.send(user, 'segunda')).rejects.toThrow(/ainda está respondendo/i);
  release();
  await first;
});

it('keeps the partial answer and marks the message when the runner dies', async () => {
  const { service, messages } = build(() => (async function* () { yield delta('comecei a olhar'); throw new Error('claude exited with 1'); })());
  const answer = await service.send(user, 'olha lá');
  expect(answer.error_code).toBe('RUNNER_FAILED');
  expect(messages.at(-1)!.text).toBe('comecei a olhar');
});

it('records an action and its failed result without breaking the answer', async () => {
  const call = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__termhub__open_tab', input: { project_id: 'p1' } }] } });
  const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true }] } });
  const { service } = build([call, result, delta('não consegui abrir a aba'), done()]);
  const answer = await service.send(user, 'abre uma aba');
  expect(answer.text).toBe('não consegui abrir a aba');
  expect(answer.error_code).toBeNull();
});

it('starts a fresh session when resuming the old one fails, and tells the client to reset the answer', async () => {
  // The runner never throws the CLI's phrase: the container classifies the failure (it is the only
  // side that sees stderr) and appends an error frame carrying `missing_session`. This is the shape
  // production really produces, so the retry is triggered off the frame, not off an error's text.
  const { service, runner, conversation, chat } = build([errorFrame('missing_session')]);
  conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000001';
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('deixa eu ver'); yield errorFrame('missing_session'); })());
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('oi'); yield done('3f1e9b1e-0000-4000-8000-000000000002'); })());

  const events: ChatEvent[] = [];
  const unsubscribe = chatBus.subscribe((e) => events.push(e));
  let answer;
  try {
    answer = await service.send(user, 'oi');
  } finally {
    unsubscribe();
  }

  expect(vi.mocked(runner.run).mock.calls[1][0]).toMatchObject({ resume: false });
  // The discarded attempt's partial text ("deixa eu ver") must not survive into the stored
  // answer, and the browser must be told to drop what it already rendered for it.
  expect(answer.text).toBe('oi');
  expect(answer.error_code).toBeNull(); // the retry succeeded: the first attempt's failure is not the answer's
  // The session the CLI no longer has is the one case that must be cleared — and it is cleared
  // before the fresh run, so the next message cannot try to resume it either.
  expect(chat.setCliSession).toHaveBeenCalledWith('c1', null);
  expect(conversation.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-000000000002');
  expect(events).toContainEqual({ type: 'reset', user_id: 'u1', message_id: answer.id });
});

it('does not retry on an error frame that is not a missing session', async () => {
  const { service, runner, conversation } = build([delta('comecei'), errorFrame('run_failed')]);
  conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000001';
  const answer = await service.send(user, 'e agora?');
  expect(vi.mocked(runner.run)).toHaveBeenCalledTimes(1);
  expect(answer.error_code).toBe('RUNNER_FAILED');
  expect(answer.text).toBe('comecei'); // whatever streamed before the failure is kept
});

it('does not retry a first (non-resumed) run even when the session is reported missing', async () => {
  const { service, runner } = build([errorFrame('missing_session')]);
  const answer = await service.send(user, 'oi');
  expect(vi.mocked(runner.run)).toHaveBeenCalledTimes(1);
  expect(answer.error_code).toBe('RUNNER_FAILED');
});

it('lets a concierge that is not configured escape as 503 and leaves no empty bubble behind', async () => {
  // Merged with no container running, every message would otherwise be stored as "the answer died"
  // and the page would say "tente de novo" for ever. The route must answer 503 instead.
  const { service, runner, messages } = build([]);
  vi.mocked(runner.run).mockImplementationOnce(() => {
    throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED');
  });

  await expect(service.send(user, 'oi')).rejects.toMatchObject({ statusCode: 503, code: 'CONCIERGE_DISABLED' });
  expect(messages.map((m) => m.role)).toEqual(['user']); // the empty assistant row is gone
});

it('lets a concierge that did not answer escape as 502', async () => {
  const { service, runner, messages } = build([]);
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () {
    throw new HttpError(502, 'O concierge não respondeu', 'CONCIERGE_FAILED');
  })());

  await expect(service.send(user, 'oi')).rejects.toMatchObject({ statusCode: 502, code: 'CONCIERGE_FAILED' });
  expect(messages.map((m) => m.role)).toEqual(['user']);
});

it('fails the run when the stream ends without a done frame', async () => {
  const { service, messages, conversation } = build(() => (async function* () { yield delta('parcial'); })());
  const answer = await service.send(user, 'e agora?');
  expect(answer.error_code).toBe('RUNNER_FAILED');
  expect(answer.text).toBe('parcial');
  expect(messages.at(-1)!.text).toBe('parcial');
  // cli_session_id was never confirmed by a done frame, so the next message must not resume it.
  expect(conversation.cli_session_id).toBeNull();
});

it('marks the run as failed when the result frame reports is_error', async () => {
  // A run that ends with is_error (max turns, an API error, every tool denied) used to be stored as
  // a clean answer with error_code null — and, with nothing streamed, an empty bubble for ever.
  const failedResult = JSON.stringify({ type: 'result', is_error: true, session_id: '3f1e9b1e-0000-4000-8000-000000000009', usage: { input_tokens: 5 } });
  const { service, conversation } = build([delta('comecei'), failedResult]);
  const answer = await service.send(user, 'faz tudo');
  expect(answer.error_code).toBe('RUNNER_FAILED');
  expect(answer.text).toBe('comecei');
  // The thread survives the failure: this server generated that uuid and the session is on disk with
  // the whole conversation, so the next message resumes it instead of starting over blind.
  expect(conversation.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-000000000009');
});

it('publishes the action and a shape-locked action_result over the bus, never the tool result payload', async () => {
  const call = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__termhub__open_tab', input: { project_id: 'p1' } }] } });
  const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true }] } });
  const { service } = build([call, result, delta('não consegui abrir a aba'), done()]);

  const events: ChatEvent[] = [];
  const unsubscribe = chatBus.subscribe((e) => events.push(e));
  try {
    await service.send(user, 'abre uma aba');
  } finally {
    unsubscribe();
  }

  const action = events.find((e) => e.type === 'action');
  expect(action).toMatchObject({ type: 'action', tool: 'open_tab', tool_use_id: 'tu_1' });

  const actionResult = events.find((e) => e.type === 'action_result');
  expect(actionResult).toBeDefined();
  // The exact key set pins the constraint that no terminal content — the tool's actual result
  // payload — ever crosses the bus: only whether the call failed, never its content.
  expect(Object.keys(actionResult!).sort()).toEqual(['message_id', 'ok', 'tool_use_id', 'type', 'user_id'].sort());
  expect(actionResult).toMatchObject({ ok: false });
});

it('marks the message with TOKEN_FAILED instead of throwing when minting the token fails', async () => {
  const { service, messages, repos } = build([delta('nunca chega'), done()]);
  vi.mocked(repos.apiTokens.create).mockRejectedValueOnce(new Error('db down'));

  const answer = await service.send(user, 'oi');
  expect(answer.error_code).toBe('TOKEN_FAILED');
  expect(answer.text).toBe('');
  expect(messages.at(-1)!.text).toBe('');
});

it('resumeAfterDecision resumes the same session with a fixed authorization sentence, and the run behaves like any other message', async () => {
  const { service, runner, conversation, messages, chatActions } = build([delta('feito'), done()]);
  conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000001';

  const answer = await service.resumeAfterDecision(user, action());

  // resume: true — the same CLI session the run was gated in, not a fresh one.
  expect(vi.mocked(runner.run).mock.calls[0][0]).toMatchObject({ resume: true, session_id: '3f1e9b1e-0000-4000-8000-000000000001' });
  // The injected line is the server's own fixed sentence, never the model's words, naming the tool
  // and its target so the model can re-issue the exact call that was gated.
  expect(messages[0].role).toBe('user');
  expect(messages[0].text).toMatch(/^O usuário autorizou:/);
  expect(messages[0].text).toContain('send_input');
  expect(messages[0].text).toContain('t1');
  // The run that follows is indistinguishable from an ordinary message: deltas, trail, stored answer.
  expect(answer.text).toBe('feito');
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  // The ordinary (unblocked) path marks the row injected itself, through the same `beforeRun` hook
  // `drainNextDecision` uses — the two paths cannot diverge (fix round 2).
  expect(chatActions.markInjected).toHaveBeenCalledWith('a1');
});

it('resumeAfterDecision sends a fixed refusal sentence for a denied action, naming the tool and target', async () => {
  const { service, conversation, messages } = build([delta('entendido'), done()]);
  conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000001';

  await service.resumeAfterDecision(user, action({ status: 'denied', tool: 'close_tab', tab_id: 't9', args: { tab_id: 't9' } }));

  expect(messages[0].text).toMatch(/^O usuário recusou:/);
  expect(messages[0].text).toContain('close_tab');
  expect(messages[0].text).toContain('t9');
});

it('resumeAfterDecision starts a fresh session and says so in the chat when no CLI session is alive', async () => {
  // Review Focus 2: an approval can arrive an hour later, when no CLI session is alive — the
  // conversation was never given one, or the CLI dropped it. `send`'s own resume/fresh choice
  // already keys off cli_session_id being null, so this must not fail or pretend to resume.
  const { service, runner, conversation, messages } = build([delta('ok'), done('3f1e9b1e-0000-4000-8000-000000000002')]);
  expect(conversation.cli_session_id).toBeNull();

  const answer = await service.resumeAfterDecision(user, action());

  expect(vi.mocked(runner.run).mock.calls[0][0]).toMatchObject({ resume: false });
  expect(messages[0].text).toMatch(/nova sessão/i);
  expect(answer.text).toBe('ok');
  expect(conversation.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-000000000002');
});

it('resumeAfterDecision answers busy when a run is already in flight, without marking the decision injected or typing anything', async () => {
  // Fix round 2: `decide()` (the route) has already flipped the row durably and published it before
  // this is ever reached — a busy lock must leave the row exactly as `decide` left it (approved or
  // denied, not yet injected) rather than mark it injected without ever sending it.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { service, runner, chatActions } = build(() => (async function* () { await gate; yield delta('ok'); yield done(); })());

  const first = service.send(user, 'primeira'); // holds the conversation's lock
  await expect(service.resumeAfterDecision(user, action())).rejects.toMatchObject({ statusCode: 409, code: 'CHAT_BUSY' });
  expect(chatActions.markInjected).not.toHaveBeenCalled();
  expect(runner.run).toHaveBeenCalledTimes(1); // only the first run's own call — nothing typed for the decision

  release();
  await first;
});

it('injects a decision left queued by a busy run exactly once, when that run finishes', async () => {
  // The state `resumeAfterDecision` would have left behind after losing the race for the lock:
  // already approved, not yet injected — `chatActions.decide` already ran in the route before the
  // busy 409 was ever thrown.
  const { service, runner, messages, chatActions } = build([], { chatActions: [action({ id: 'a1' })] });
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('resposta original'); yield done(); })());
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('feito'); yield done(); })());

  await service.send(user, 'mensagem original'); // its own completion drains the queue before resolving

  expect(runner.run).toHaveBeenCalledTimes(2);
  expect(chatActions.markInjected).toHaveBeenCalledWith('a1');
  const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.text);
  expect(userTexts).toEqual(['mensagem original', expect.stringMatching(/^O usuário autorizou:.*send_input/s)]);

  // A second, unrelated completion must not inject the same decision again: it is already marked.
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('outra resposta'); yield done(); })());
  await service.send(user, 'outra mensagem');
  expect(runner.run).toHaveBeenCalledTimes(3); // one more call, not two — nothing left to drain
  expect(chatActions.markInjected).toHaveBeenCalledTimes(1);
});

it('drains two decisions queued behind one run, one per completion, oldest first', async () => {
  const first = action({ id: 'a1', tool: 'send_input', tab_id: 't1', decided_at: '2026-09-21T12:00:00.000Z' });
  const second = action({ id: 'a2', tool: 'close_tab', tab_id: 't2', decided_at: '2026-09-21T12:01:00.000Z' });
  const { service, runner, messages, chatActions } = build([], { chatActions: [second, first] }); // seeded out of order: the drain must still go by decided_at
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('r0'); yield done(); })());
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('r1'); yield done(); })());
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('r2'); yield done(); })());

  await service.send(user, 'mensagem original');

  expect(runner.run).toHaveBeenCalledTimes(3);
  const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.text);
  expect(userTexts[0]).toBe('mensagem original');
  expect(userTexts[1]).toContain('send_input'); // a1: decided first
  expect(userTexts[2]).toContain('close_tab'); // a2: decided second
  expect(chatActions.markInjected).toHaveBeenNthCalledWith(1, 'a1');
  expect(chatActions.markInjected).toHaveBeenNthCalledWith(2, 'a2');
});
