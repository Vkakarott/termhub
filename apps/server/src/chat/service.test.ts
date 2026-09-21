import { beforeEach, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { chatBus, type ChatEvent } from './bus.js';
import { ChatService, type RunnerClient } from './service.js';

const user = { id: 'u1', email: 'p@test', role_id: 'role_authenticated' } as unknown as User;

function build(lines: string[] | (() => AsyncIterable<string>)) {
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
    listMessages: vi.fn(async () => messages),
  };
  const repos = { chat, apiTokens: { listByUser: vi.fn(async () => []), create: vi.fn(async () => ({})), revoke: vi.fn(async () => undefined) } } as unknown as Repositories;
  const runner: RunnerClient = {
    run: vi.fn(() => (typeof lines === 'function' ? lines() : (async function* () { for (const l of lines) yield l; })())),
  };
  return { service: new ChatService({ repos, runner, configDirs: { primary: '/accounts/primary' } }), chat, runner, messages, conversation, repos };
}

const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const done = (session = '3f1e9b1e-0000-4000-8000-000000000001') => JSON.stringify({ type: 'result', session_id: session, usage: { input_tokens: 5 } });

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
  const { service, runner, conversation } = build(() => (async function* () { throw new Error('No conversation found with session ID'); })());
  conversation.cli_session_id = '3f1e9b1e-0000-4000-8000-000000000001';
  vi.mocked(runner.run).mockImplementationOnce(() => (async function* () { yield delta('deixa eu ver'); throw new Error('No conversation found with session ID'); })());
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
  expect(events).toContainEqual({ type: 'reset', user_id: 'u1', message_id: answer.id });
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
