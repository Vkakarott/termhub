import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { applyErrorHandler } from '../lib/errors.js';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { chatRoutes } from './chat.js';

const pendingAction = { id: 'act1', conversation_id: 'c1', tool: 'send_input', args: { tab_id: 't1' }, class: 'write', tab_id: 't1', machine_id: null, project_id: null };

function build(opts: {
  send?: ReturnType<typeof vi.fn>;
  resumeAfterDecision?: ReturnType<typeof vi.fn>;
  decide?: ReturnType<typeof vi.fn>;
  findByIdForUser?: ReturnType<typeof vi.fn>;
  listByConversation?: ReturnType<typeof vi.fn>;
  tabs?: { id: string; project_id: string; name: string }[];
  projects?: { id: string; machine_id: string; name: string }[];
  machines?: { id: string; name: string }[];
} = {}) {
  const send = opts.send ?? vi.fn(async () => ({ id: 'm2', role: 'assistant', text: 'Nada rodando.' }));
  const resumeAfterDecision = opts.resumeAfterDecision ?? vi.fn(async () => ({ id: 'm3', role: 'assistant', text: 'Feito.' }));
  const decide = opts.decide ?? vi.fn(async (_id: string, _userId: string, status: string) => ({ ...pendingAction, status }));
  const findByIdForUser = opts.findByIdForUser ?? vi.fn(async () => undefined);
  const listByConversation = opts.listByConversation ?? vi.fn(async () => []);
  const service = {
    conversationFor: vi.fn(async () => ({ id: 'c1', user_id: 'u1', review_mode: false })),
    send,
    resumeAfterDecision,
  };
  const tabs = opts.tabs ?? [];
  const projects = opts.projects ?? [];
  const machines = opts.machines ?? [];
  const repos = {
    chat: { listMessages: vi.fn(async () => [{ id: 'm1', role: 'user', text: 'oi' }]) },
    chatActions: { decide, findByIdForUser, listByConversation },
    tabs: { findByIds: vi.fn(async (ids: string[]) => tabs.filter((t) => ids.includes(t.id))) },
    projects: { findByIds: vi.fn(async (ids: string[]) => projects.filter((p) => ids.includes(p.id))) },
    machines: { findByIds: vi.fn(async (ids: string[]) => machines.filter((m) => ids.includes(m.id))) },
  };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  app.register((a) => chatRoutes(a, repos as never, { service: service as never }), { prefix: '/chat' });
  return { app, service, decide, findByIdForUser, listByConversation, resumeAfterDecision };
}

it('returns the conversation with its messages', async () => {
  const { app } = build();
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ conversation: { id: 'c1' }, messages: [{ id: 'm1', text: 'oi' }] });
});

it('returns the trail as sentences enriched with real names, keyed by each row\'s own id — not a raw tool name and ids', async () => {
  // The trail must come from here, not be rebuilt from live events, so a reload still shows it
  // (step 1's bug this task closes) — and every row is keyed by its own id, since a lapsed denial
  // leaves an old decided row beside a newer pending one for the very same proposal.
  const rows = [
    { ...pendingAction, id: 'act1', status: 'pending', args: { tab_id: 't1', text: 'npm test' } },
    { ...pendingAction, id: 'act0', status: 'denied', args: { tab_id: 't1', text: 'rm -rf /' } },
  ];
  const { app } = build({
    listByConversation: vi.fn(async () => rows),
    tabs: [{ id: 't1', project_id: 'p1', name: 'Terminal 2' }],
    projects: [{ id: 'p1', machine_id: 'm1', name: 'reactivando' }],
    machines: [{ id: 'm1', name: 'macbook m3' }],
  });

  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.statusCode).toBe(200);
  const { actions } = res.json();
  expect(actions).toHaveLength(2);
  const pending = actions.find((a: { id: string }) => a.id === 'act1');
  const denied = actions.find((a: { id: string }) => a.id === 'act0');
  expect(pending).toMatchObject({ id: 'act1', status: 'pending' });
  expect(pending.summary).toBe('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3');
  expect(denied).toMatchObject({ id: 'act0', status: 'denied' });
  expect(denied.summary).toBe('digitar `rm -rf /` na aba Terminal 2 do projeto reactivando, no macbook m3');
});

it('sends a message and answers with the assistant row', async () => {
  const { app, service } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'o que está rodando?' } });
  expect(res.statusCode).toBe(201);
  expect(res.json().message.text).toBe('Nada rodando.');
  expect(service.send.mock.calls[0][1]).toBe('o que está rodando?');
});

it('rejects an empty or oversized message', async () => {
  const { app } = build();
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: '   ' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'x'.repeat(8001) } })).statusCode).toBe(400);
});

it('passes the service busy error through as 409', async () => {
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ send: vi.fn(async () => { throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'segunda' } });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('CHAT_BUSY');
});

it('surfaces a concierge that is not configured as 503, not as a stored failure', async () => {
  // Merged with no container running, every message would otherwise be answered 201 with a message
  // marked as failed, and the page would say "tente de novo" for ever. The status must reach the
  // browser so it can show the server's own pt-BR explanation.
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ send: vi.fn(async () => { throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi' } });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({ code: 'CONCIERGE_DISABLED', error: 'O chat não está configurado neste servidor' });
});

it('surfaces a concierge that did not answer as 502', async () => {
  const { HttpError } = await import('../lib/errors.js');
  const { app } = build({ send: vi.fn(async () => { throw new HttpError(502, 'O concierge não respondeu', 'CONCIERGE_FAILED'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/messages', payload: { text: 'oi' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().code).toBe('CONCIERGE_FAILED');
});

it('approves a row the user owns: 200, decided through the repository, and the run is resumed', async () => {
  const { app, decide, resumeAfterDecision } = build();
  const events: ChatEvent[] = [];
  const unsubscribe = chatBus.subscribe((e) => events.push(e));
  let res;
  try {
    res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
  } finally {
    unsubscribe();
  }

  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved');
  expect(resumeAfterDecision).toHaveBeenCalledTimes(1);
  expect(resumeAfterDecision.mock.calls[0][0]).toMatchObject({ id: 'u1' });
  expect(resumeAfterDecision.mock.calls[0][1]).toMatchObject({ id: 'act1', status: 'approved' });
  // Every open tab must learn of the decision, not only the one that clicked.
  expect(events).toContainEqual({ type: 'decision', user_id: 'u1', action_id: 'act1', status: 'approved' });
});

it('denies a row the user owns: 200, decided as denied, and the run is resumed', async () => {
  const { app, decide, resumeAfterDecision } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'deny' } });

  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'denied');
  expect(resumeAfterDecision.mock.calls[0][1]).toMatchObject({ id: 'act1', status: 'denied' });
});

it('answers 404 for a row that does not exist, or belongs to another user, without ever calling resumeAfterDecision', async () => {
  // `decide` filters ownership in SQL and returns undefined either way; `findByIdForUser` is scoped
  // the same way (the owning conversation's user_id), so a wrong id or another user's row both come
  // back undefined from it too, and the route answers 404 rather than 409.
  const { app, resumeAfterDecision, findByIdForUser } = build({ decide: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => undefined) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/nope/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(404);
  expect(findByIdForUser).toHaveBeenCalledWith('nope', 'u1');
  expect(resumeAfterDecision).not.toHaveBeenCalled();
});

it('answers 409 for a row this user already decided, without deciding it again or resuming', async () => {
  const decided = { ...pendingAction, id: 'act1', status: 'approved' };
  const { app, resumeAfterDecision } = build({ decide: vi.fn(async () => undefined), findByIdForUser: vi.fn(async () => decided) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(409);
  expect(resumeAfterDecision).not.toHaveBeenCalled();
});

it('answers 400 for an unknown decision value, without touching the repository', async () => {
  const { app, decide } = build();
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'maybe' } });

  expect(res.statusCode).toBe(400);
  expect(decide).not.toHaveBeenCalled();
});

it('answers 200 (not 409) when the decision is recorded but a run is busy, and says it will be applied later', async () => {
  // The decision is already durably recorded and already published above this point — a 409 here
  // would tell the client its own successful decision was a conflict. `ChatService.drainNextDecision`
  // picks the row up (still approved/denied, never injected) once the busy run's own lock frees up.
  const { HttpError } = await import('../lib/errors.js');
  const { app, decide } = build({ resumeAfterDecision: vi.fn(async () => { throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(200);
  expect(decide).toHaveBeenCalledWith('act1', 'u1', 'approved'); // the decision itself still happened
  expect(res.json()).toMatchObject({ action: { id: 'act1', status: 'approved' }, queued: true });
  expect(res.json().note).toMatch(/registrada/i);
});

it('lets any other resumeAfterDecision failure through unchanged, not the busy 200', async () => {
  const { app } = build({ resumeAfterDecision: vi.fn(async () => { throw new Error('boom'); }) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(res.statusCode).toBe(500);
});

it('a double click on the same decision still answers 409 the second time, having injected only once', async () => {
  let decided = false;
  const decide = vi.fn(async (_id: string, _userId: string, status: string) => {
    if (decided) return undefined;
    decided = true;
    return { ...pendingAction, status };
  });
  const findByIdForUser = vi.fn(async () => ({ ...pendingAction, status: 'approved' }));
  const { app, resumeAfterDecision } = build({ decide, findByIdForUser });

  const first = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
  const second = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });

  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(409);
  expect(resumeAfterDecision).toHaveBeenCalledTimes(1); // injected once — the second click never reaches it
});
