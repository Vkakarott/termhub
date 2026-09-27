import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { applyErrorHandler } from '../lib/errors.js';

vi.mock('../chat/tab-questions.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../chat/tab-questions.js')>()), publishTabQuestions: vi.fn(async () => []) }));
const { publishTabQuestions } = await import('../chat/tab-questions.js');
const { chatRoutes } = await import('./chat.js');
const { mobileChatRoutes } = await import('./m-chat.js');

function fakeRepos() {
  return {
    chatDecisions: {
      listForUser: vi.fn(async () => ({ items: [], next_cursor: null })),
      deleteForUser: vi.fn(async () => true),
      countForUser: vi.fn(async () => 0),
    },
    memoryItems: {
      listNotes: vi.fn(async () => ({ items: [], next_cursor: null })),
      deleteNote: vi.fn(async () => true),
      countNotesSince: vi.fn(async () => 0),
    },
    users: {
      chatSuggestions: vi.fn(async () => true),
      setChatSuggestions: vi.fn(async () => undefined),
      chatAutodecide: vi.fn(async () => false),
      setChatAutodecide: vi.fn(async () => undefined),
    },
    tabQuestions: {
      cancelScheduledForUser: vi.fn(async (_userId: string) => [] as { id: string }[]),
    },
  };
}

function build(kind: 'web' | 'mobile', repos: ReturnType<typeof fakeRepos>) {
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  if (kind === 'web') app.register((a) => chatRoutes(a, repos as never, { service: {} as never }), { prefix: '/chat' });
  else app.register((a) => mobileChatRoutes(a, repos as never, { chat: {} as never, agents: {} as never, session: {} as never }), { prefix: '/chat' });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe.each(['web', 'mobile'] as const)('%s chat memory routes', (kind) => {
  it('GET /decisions passes the user, q, cursor and the fixed page size, and never leaks embedding', async () => {
    const repos = fakeRepos();
    repos.chatDecisions.listForUser.mockResolvedValueOnce({
      items: [
        {
          id: 'd1',
          user_id: 'u1',
          project_id: 'p1',
          project_name: 'Proj',
          conversation_id: 'c1',
          tab_question_id: 'q1',
          question_index: 0,
          header: 'Header',
          question: 'Question?',
          options: [{ label: 'a', description: 'da' }],
          multi_select: false,
          answer: { labels: ['a'] },
          embed_model: 'm',
          suggested_count: 2,
          accepted_count: 1,
          created_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: 'CURSOR',
    });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/decisions?q=abc&cursor=xyz' });
    expect(res.statusCode).toBe(200);
    expect(repos.chatDecisions.listForUser).toHaveBeenCalledWith('u1', { q: 'abc', cursor: 'xyz', limit: 50 });
    const body = res.json();
    expect(body.next_cursor).toBe('CURSOR');
    expect(body.decisions).toHaveLength(1);
    const decision = body.decisions[0];
    expect(decision).toEqual({
      id: 'd1',
      project_id: 'p1',
      project_name: 'Proj',
      header: 'Header',
      question: 'Question?',
      options: [{ label: 'a', description: 'da' }],
      multi_select: false,
      answer: { labels: ['a'] },
      suggested_count: 2,
      accepted_count: 1,
      created_at: '2026-09-26T00:00:00.000Z',
    });
    expect(decision).not.toHaveProperty('embedding');
    expect(decision).not.toHaveProperty('user_id');
    expect(decision).not.toHaveProperty('conversation_id');
    expect(decision).not.toHaveProperty('tab_question_id');
    expect(decision).not.toHaveProperty('question_index');
    expect(decision).not.toHaveProperty('embed_model');
  });

  it('GET /decisions refuses a q over 200 chars', async () => {
    const repos = fakeRepos();
    const res = await build(kind, repos).inject({ method: 'GET', url: `/chat/decisions?q=${'a'.repeat(201)}` });
    expect(res.statusCode).toBe(400);
    expect(repos.chatDecisions.listForUser).not.toHaveBeenCalled();
  });

  it('DELETE /decisions/:id calls deleteForUser and answers 204 whether or not it existed', async () => {
    const repos = fakeRepos();
    repos.chatDecisions.deleteForUser.mockResolvedValueOnce(true);
    const res1 = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/decisions/d1' });
    expect(res1.statusCode).toBe(204);
    expect(repos.chatDecisions.deleteForUser).toHaveBeenCalledWith('d1', 'u1');

    const repos2 = fakeRepos();
    repos2.chatDecisions.deleteForUser.mockResolvedValueOnce(false);
    const res2 = await build(kind, repos2).inject({ method: 'DELETE', url: '/chat/decisions/missing' });
    expect(res2.statusCode).toBe(204);
  });

  it('GET /memory answers the suggestion switch, autodecide, availability, decisions count and notes count (no EMBED_URL in tests)', async () => {
    const repos = fakeRepos();
    repos.users.chatSuggestions.mockResolvedValueOnce(true);
    repos.users.chatAutodecide.mockResolvedValueOnce(true);
    repos.chatDecisions.countForUser.mockResolvedValueOnce(7);
    repos.memoryItems.countNotesSince.mockResolvedValueOnce(2);
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/memory' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, autodecide: true, available: false, count: 7, notes: 2 });
    expect(repos.memoryItems.countNotesSince).toHaveBeenCalledWith('u1', new Date(0));
  });

  it('PATCH /memory sets the suggestion switch and leaves autodecide alone', async () => {
    const repos = fakeRepos();
    repos.users.chatSuggestions.mockResolvedValueOnce(false);
    repos.chatDecisions.countForUser.mockResolvedValueOnce(3);
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(repos.users.setChatSuggestions).toHaveBeenCalledWith('u1', false);
    expect(repos.users.setChatAutodecide).not.toHaveBeenCalled();
    expect(res.json()).toEqual({ enabled: false, autodecide: false, available: false, count: 3, notes: 0 });
  });

  it('PATCH /memory sets autodecide and leaves the suggestion switch alone', async () => {
    const repos = fakeRepos();
    repos.users.chatAutodecide.mockResolvedValueOnce(true);
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { autodecide: true } });
    expect(res.statusCode).toBe(200);
    expect(repos.users.setChatAutodecide).toHaveBeenCalledWith('u1', true);
    expect(repos.users.setChatSuggestions).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ autodecide: true });
  });

  it('PATCH /memory with autodecide: false cancels the user\'s running countdowns and republishes those cards', async () => {
    const repos = fakeRepos();
    const cancelled = [{ id: 'q1', user_id: 'u1' }, { id: 'q2', user_id: 'u1' }];
    repos.tabQuestions.cancelScheduledForUser.mockResolvedValueOnce(cancelled);
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { autodecide: false } });
    expect(res.statusCode).toBe(200);
    expect(repos.users.setChatAutodecide).toHaveBeenCalledWith('u1', false);
    expect(repos.tabQuestions.cancelScheduledForUser).toHaveBeenCalledWith('u1');
    // The switch is stored first, so the repeat path cannot schedule a new one behind the cancel.
    expect(repos.users.setChatAutodecide.mock.invocationCallOrder[0]!).toBeLessThan(repos.tabQuestions.cancelScheduledForUser.mock.invocationCallOrder[0]!);
    expect(publishTabQuestions).toHaveBeenCalledWith(repos, 'tab_question', cancelled);
  });

  it('PATCH /memory with autodecide: true (or only enabled) cancels nothing', async () => {
    const repos = fakeRepos();
    await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { autodecide: true } });
    await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { enabled: false } });
    expect(repos.tabQuestions.cancelScheduledForUser).not.toHaveBeenCalled();
    expect(publishTabQuestions).not.toHaveBeenCalled();
  });

  it('PATCH /memory with autodecide: false and nothing counting down publishes nothing', async () => {
    const repos = fakeRepos();
    await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { autodecide: false } });
    expect(repos.tabQuestions.cancelScheduledForUser).toHaveBeenCalledWith('u1');
    expect(publishTabQuestions).not.toHaveBeenCalled();
  });

  it('PATCH /memory refuses an empty body (neither key)', async () => {
    const repos = fakeRepos();
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(repos.users.setChatSuggestions).not.toHaveBeenCalled();
    expect(repos.users.setChatAutodecide).not.toHaveBeenCalled();
  });

  it('GET and PATCH /memory answer available: true when embeddings are configured', async () => {
    const saved = config.embeddings;
    config.embeddings = { url: 'http://embed:8000', secret: 's' };
    try {
      const repos = fakeRepos();
      const app = build(kind, repos);
      const got = await app.inject({ method: 'GET', url: '/chat/memory' });
      expect(got.json()).toMatchObject({ available: true });
      const patched = await app.inject({ method: 'PATCH', url: '/chat/memory', payload: { enabled: true } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ available: true });
    } finally {
      config.embeddings = saved;
    }
  });

  it('PATCH /memory refuses a non-boolean enabled', async () => {
    const repos = fakeRepos();
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { enabled: 'no' } });
    expect(res.statusCode).toBe(400);
    expect(repos.users.setChatSuggestions).not.toHaveBeenCalled();
  });

  it('GET /notes passes the user and cursor, maps question/decision/reason from the stored text', async () => {
    const repos = fakeRepos();
    repos.memoryItems.listNotes.mockResolvedValueOnce({
      items: [
        {
          id: 'n1',
          owner_id: 'u1',
          project_id: 'p1',
          project_name: 'Proj',
          kind: 'note',
          source_id: 'n1',
          chunk_index: 0,
          title: 'Qual gerenciador de pacotes devo usar?',
          text: 'Decisão: npm\nMotivo: é o padrão do Node\nFontes: spec.md',
          trust: 'derived',
          content_hash: 'h',
          source_hash: null,
          embed_model: null,
          source_at: '2026-09-26T00:00:00.000Z',
          created_at: '2026-09-26T00:00:00.000Z',
          updated_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: 'CURSOR',
    });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/notes?cursor=xyz' });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryItems.listNotes).toHaveBeenCalledWith('u1', { cursor: 'xyz', limit: 50 });
    expect(res.json()).toEqual({
      notes: [
        {
          id: 'n1',
          project_id: 'p1',
          project_name: 'Proj',
          question: 'Qual gerenciador de pacotes devo usar?',
          decision: 'npm',
          reason: 'é o padrão do Node',
          created_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: 'CURSOR',
    });
  });

  it('GET /notes answers empty decision/reason for a note missing those lines, never throwing', async () => {
    const repos = fakeRepos();
    repos.memoryItems.listNotes.mockResolvedValueOnce({
      items: [
        {
          id: 'n1',
          owner_id: 'u1',
          project_id: null,
          project_name: null,
          kind: 'note',
          source_id: 'n1',
          chunk_index: 0,
          title: 'Q',
          text: 'nada aqui',
          trust: 'derived',
          content_hash: 'h',
          source_hash: null,
          embed_model: null,
          source_at: '2026-09-26T00:00:00.000Z',
          created_at: '2026-09-26T00:00:00.000Z',
          updated_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/notes' });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes[0]).toEqual({
      id: 'n1',
      project_id: null,
      project_name: null,
      question: 'Q',
      decision: '',
      reason: '',
      created_at: '2026-09-26T00:00:00.000Z',
    });
  });

  it('DELETE /notes/:id calls deleteNote scoped to this user and answers 204 whether or not it existed (another user\'s note, or a non-note item, survive)', async () => {
    const repos = fakeRepos();
    repos.memoryItems.deleteNote.mockResolvedValueOnce(true);
    const res1 = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/notes/n1' });
    expect(res1.statusCode).toBe(204);
    expect(repos.memoryItems.deleteNote).toHaveBeenCalledWith('n1', 'u1');

    const repos2 = fakeRepos();
    repos2.memoryItems.deleteNote.mockResolvedValueOnce(false);
    const res2 = await build(kind, repos2).inject({ method: 'DELETE', url: '/chat/notes/other' });
    expect(res2.statusCode).toBe(204);
  });
});
