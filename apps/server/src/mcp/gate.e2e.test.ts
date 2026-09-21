import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentConnection } from '../agent/connection.js';
import { agents } from '../agent/registry.js';
import { hashApiToken } from '../auth/api-tokens.js';
import { canAccess } from '../auth/permissions.js';
import { chatBus } from '../chat/bus.js';
import { idempotencyKeyFor } from '../chat/gate.js';
import type { ChatAction, InsertPendingInput } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { mcpRoutes } from './route.js';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));

const SECRET = 'thb_pat_' + 'A'.repeat(43);
const CONVERSATION = 'c1';
const machine = { id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const project = { id: 'p1', name: 'app', cwd: '/home/u/app', machine_id: 'm1', status: 'active', owner_id: 'u1' };

/** The fake machine: one tmux session whose screen is whatever was typed into it. */
function attachFakeTmux(typed: string[]) {
  const conn = {
    machineId: machine.id,
    hello: { agent_version: '0.2.0', os: 'linux', tools: ['tmux'] },
    connectedAt: Date.now(),
    close: vi.fn(),
    openPty: vi.fn(),
    on() {
      return this;
    },
    rpc: vi.fn(async (method: string, params: unknown) => {
      const p = params as { text?: string };
      if (method === 'tmux.ensure') return { created: true };
      if (method === 'tmux.sendText') {
        typed.push(p.text ?? '');
        return { sent: true };
      }
      if (method === 'tmux.capture') return { text: typed.join('\n') };
      throw new Error(`unexpected rpc ${method}`);
    }),
  } as unknown as AgentConnection;
  agents.attach(machine.id, conn);
  return conn;
}

/** The repository's real semantics in memory: the partial unique index means a second *open* row
 * for a key throws, and a decided row is invisible to `findOpenByKey`. */
function fakeChatActions() {
  const rows: ChatAction[] = [];
  const isOpen = (r: ChatAction) => r.status === 'pending' || r.status === 'approved';
  const sameKey = (r: ChatAction, conversationId: string, key: string) => r.conversation_id === conversationId && r.idempotency_key === key;
  return {
    rows,
    findOpenByKey: vi.fn(async (conversationId: string, key: string) => rows.find((r) => sameKey(r, conversationId, key) && isOpen(r))),
    findDeniedByKey: vi.fn(async (conversationId: string, key: string) => [...rows].reverse().find((r) => sameKey(r, conversationId, key) && r.status === 'denied')),
    insertPending: vi.fn(async (input: InsertPendingInput) => {
      if (rows.some((r) => sameKey(r, input.conversation_id, input.idempotency_key ?? '') && isOpen(r))) {
        throw new Error('duplicate key value violates unique constraint "chat_actions_one_open_per_key"');
      }
      const row: ChatAction = {
        id: `a${rows.length + 1}`,
        conversation_id: input.conversation_id,
        message_id: input.message_id ?? null,
        tool: input.tool,
        args: input.args,
        class: input.class,
        status: 'pending',
        idempotency_key: input.idempotency_key ?? null,
        machine_id: input.machine_id ?? null,
        project_id: input.project_id ?? null,
        tab_id: input.tab_id ?? null,
        error_code: null,
        duration_ms: null,
        decided_by: null,
        decided_at: null,
        created_at: new Date().toISOString(),
      };
      rows.push(row);
      return row;
    }),
    markExecuted: vi.fn(async (id: string, ok: boolean, errorCode?: string | null, durationMs?: number | null) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.status = ok ? 'executed' : 'failed';
      row.error_code = errorCode ?? null;
      row.duration_ms = durationMs ?? null;
    }),
    /**
     * A row already decided on, as the chat's confirmation endpoint (or the expiry sweep) leaves it.
     * `decidedMinutesAgo` dates the decision: the gate's refusal window is measured from `decided_at`,
     * so backdating the row is how the clock is moved — no fake timers, no waiting.
     */
    seed: (status: 'approved' | 'denied' | 'expired', tool: string, args: Record<string, unknown>, decidedMinutesAgo = 0) => {
      const decidedAt = new Date(Date.now() - decidedMinutesAgo * 60 * 1000).toISOString();
      const row: ChatAction = {
        id: `a${rows.length + 1}`,
        conversation_id: CONVERSATION,
        message_id: null,
        tool,
        args,
        class: 'write',
        status,
        idempotency_key: idempotencyKeyFor(CONVERSATION, tool, args),
        machine_id: null,
        project_id: null,
        tab_id: typeof args.tab_id === 'string' ? args.tab_id : null,
        error_code: null,
        duration_ms: null,
        decided_by: status === 'expired' ? null : 'u1',
        decided_at: status === 'expired' ? null : decidedAt,
        created_at: decidedAt,
      };
      rows.push(row);
      return row;
    },
  };
}

function build(opts: { gated: boolean }) {
  const tabs = new Map<string, Record<string, unknown>>([
    ['t1', { id: 't1', project_id: 'p1', name: 'Terminal 1', kind: 'terminal', tmux_session: 'termhub-p1-t1', simulator_udid: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', created_by_token_id: null }],
  ]);
  const apiTokens = {
    findActiveByHash: vi.fn(async (h: string) => (h === hashApiToken(SECRET) ? { id: 'tok1', user_id: 'u1', name: 'concierge', scopes: ['read', 'terminals'], expires_at: null, revoked_at: null, last_used_at: null, created_at: '', gated: opts.gated } : undefined)),
    touchLastUsed: vi.fn(async () => {}),
    recordEvent: vi.fn(async () => {}),
  };
  const actions = fakeChatActions();
  const chat = { getOrCreateForUser: vi.fn(async (userId: string) => ({ id: CONVERSATION, user_id: userId, cli_session_id: null, created_at: '' })) };
  const repos = {
    apiTokens,
    chat,
    chatActions: actions,
    users: { findById: vi.fn(async () => ({ id: 'u1', role_id: 'r' })) },
    machines: { findById: vi.fn(async () => machine), list: vi.fn(async () => [machine]) },
    projects: { findById: vi.fn(async () => project) },
    tasks: { listByProject: vi.fn(async () => []) },
    tabs: {
      listByProject: vi.fn(async () => [...tabs.values()]),
      countOpenByToken: vi.fn(async () => 0),
      findById: vi.fn(async (id: string) => tabs.get(id)),
      delete: vi.fn(async (id: string) => tabs.delete(id)),
    },
  } as unknown as Repositories;

  const app = Fastify();
  applyErrorHandler(app);
  app.register((a) => mcpRoutes(a, { repos, version: '0.0.0-test' }));
  return { app, apiTokens, actions, tabs };
}

const callTool = (app: ReturnType<typeof Fastify>, name: string, args: object) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${SECRET}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });

type Injected = Awaited<ReturnType<typeof callTool>>;
const resultOf = (res: Injected) => (res.json() as { result: { content: { text: string }[]; isError?: boolean } }).result;
const textOf = (res: Injected) => resultOf(res).content[0].text;
const payloadOf = (res: Injected) => JSON.parse(textOf(res));
/** `recordEvent` is fired and forgotten by the route; a macrotask turn is enough for it to land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const collected: Record<string, unknown>[] = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  agents.reset();
  vi.mocked(canAccess).mockResolvedValue(true);
  collected.length = 0;
  unsubscribe = chatBus.subscribe((event) => collected.push(event as unknown as Record<string, unknown>));
});

afterEach(() => unsubscribe?.());

it('asks instead of acting, and says so in a way the model can act on', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, apiTokens } = build({ gated: true });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(typed).toEqual([]); // nothing was typed
  expect(actions.rows[0]).toMatchObject({ status: 'pending', tool: 'send_input', class: 'write', tab_id: 't1', args: { tab_id: 't1', text: 'npm test' } });

  // the per-call audit row is still written exactly once, with the existing shape
  await settle();
  expect(apiTokens.recordEvent).toHaveBeenCalledTimes(1);
  expect(apiTokens.recordEvent.mock.calls[0][0]).toMatchObject({ token_id: 'tok1', tool: 'send_input', tab_id: 't1', ok: false, error_code: 'CONFIRMATION_PENDING' });
  expect(JSON.stringify(apiTokens.recordEvent.mock.calls[0][0])).not.toContain('npm test');
});

it('does not ask twice for the same proposal', async () => {
  attachFakeTmux([]);
  const { app, actions } = build({ gated: true });

  await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  const again = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(again).isError).toBe(true);
  expect(textOf(again)).toMatch(/ainda está aguardando a confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(actions.rows).toHaveLength(1);
});

it('asks only once when a concurrent duplicate insert loses the unique index', async () => {
  attachFakeTmux([]);
  const { app, actions } = build({ gated: true });
  await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });
  // The racing request read the table before the first insert committed, so it still tries to
  // insert: the partial unique index rejects it, and it must answer "waiting" instead of failing.
  actions.findOpenByKey.mockResolvedValueOnce(undefined);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/ainda está aguardando a confirmação/i);
  expect(actions.insertPending).toHaveBeenCalledTimes(2);
  expect(actions.rows).toHaveLength(1);
});

it('executes once the row is approved, and marks it executed', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBeUndefined();
  expect(payloadOf(res)).toMatchObject({ tab_id: 't1', sent: true });
  expect(typed).toEqual(['npm test']);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, true, null, expect.any(Number));
  expect(actions.rows[0].status).toBe('executed');
  expect(actions.insertPending).not.toHaveBeenCalled();
});

it('keeps refusing right after a denial, without asking again', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.seed('denied', 'send_input', { tab_id: 't1', text: 'npm test' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/recusou/i);
  expect(typed).toEqual([]);
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(actions.rows).toHaveLength(1);
});

it('still refuses the identical proposal a minute after the denial', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.seed('denied', 'send_input', { tab_id: 't1', text: 'npm test' }, 1);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/recusou/i);
  expect(typed).toEqual([]);
  expect(actions.insertPending).not.toHaveBeenCalled();
});

it('asks again once the denial is older than the window: the user may have changed their mind', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.seed('denied', 'send_input', { tab_id: 't1', text: 'npm test' }, 16);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(typed).toEqual([]); // still nothing typed: it is a question, not an action
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(actions.rows.map((r) => r.status)).toEqual(['denied', 'pending']);
  expect(collected.map((e) => e.type)).toEqual(['confirmation']);
});

it('asks a question left to expire again, because nobody ever answered it', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: true });
  actions.seed('expired', 'send_input', { tab_id: 't1', text: 'npm test' }, 60 * 25);

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toMatch(/pendente de confirmação/i);
  expect(typed).toEqual([]);
  expect(actions.insertPending).toHaveBeenCalledTimes(1);
  expect(actions.rows.map((r) => r.status)).toEqual(['expired', 'pending']);
  expect(collected.map((e) => e.type)).toEqual(['confirmation']);
});

it('re-validates the tab before executing an approved action', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, tabs } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });
  tabs.delete('t1'); // the tab was killed while the question waited

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(textOf(res)).toContain('t1');
  expect(typed).toEqual([]);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, false, 'TAB_GONE', expect.any(Number));
  expect(actions.rows[0].status).toBe('failed');
});

it('refuses an approved keystroke into a tab that is now waiting for a permission', async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions, tabs } = build({ gated: true });
  const row = actions.seed('approved', 'send_input', { tab_id: 't1', text: 'npm test' });
  tabs.set('t1', { ...tabs.get('t1')!, state: 'waiting_permission', state_text: 'Allow edit?' });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBe(true);
  expect(typed).toEqual([]);
  expect(actions.markExecuted).toHaveBeenCalledWith(row.id, false, 'WAITING_PERMISSION', expect.any(Number));
  expect(actions.rows[0].status).toBe('failed');
});

it("lets a person's own token through untouched", async () => {
  const typed: string[] = [];
  attachFakeTmux(typed);
  const { app, actions } = build({ gated: false });

  const res = await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(resultOf(res).isError).toBeUndefined();
  expect(typed).toEqual(['npm test']);
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(actions.findOpenByKey).not.toHaveBeenCalled();
  expect(collected).toEqual([]);
});

it('never gates a read', async () => {
  attachFakeTmux(['npm test']);
  const { app, actions } = build({ gated: true });

  const res = await callTool(app, 'read_screen', { tab_id: 't1', lines: 10 });

  expect(resultOf(res).isError).toBeUndefined();
  expect(payloadOf(res).text).toContain('npm test');
  expect(actions.insertPending).not.toHaveBeenCalled();
  expect(actions.findOpenByKey).not.toHaveBeenCalled();
});

it('publishes the question to the chat, with the arguments and no terminal content', async () => {
  attachFakeTmux(['segredo na tela']);
  const { app, actions } = build({ gated: true });

  await callTool(app, 'send_input', { tab_id: 't1', text: 'npm test' });

  expect(collected).toHaveLength(1);
  expect(Object.keys(collected[0]).sort()).toEqual(['action_id', 'args', 'class', 'machine_id', 'project_id', 'tab_id', 'tool', 'type', 'user_id']);
  expect(collected[0]).toEqual({
    type: 'confirmation',
    user_id: 'u1',
    action_id: actions.rows[0].id,
    tool: 'send_input',
    args: { tab_id: 't1', text: 'npm test' },
    class: 'write',
    machine_id: null,
    project_id: null,
    tab_id: 't1',
  });
  expect(JSON.stringify(collected[0])).not.toContain('segredo na tela');
});
