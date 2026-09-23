import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { monitorBus } from '../monitor/bus.js';

const { sendKeysToSession } = vi.hoisted(() => ({ sendKeysToSession: vi.fn() }));
vi.mock('../monitor/send-keys.js', () => ({ INPUT_MAX_CHARS: 4000, sendKeysToSession }));

import { tabRoutes } from './tabs.js';

const tab = (over: Partial<Tab> & { id: string; project_id?: string }): Tab => ({
  project_id: 'p1',
  machine_id: 'm1',
  name: 'claude',
  kind: 'terminal',
  tmux_session: `th-${over.id}`,
  simulator_udid: null,
  position: 0,
  state: null,
  state_text: null,
  state_tool: null,
  state_at: null,
  state_seen_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  ...over,
});

/** Routes over stubbed repos and a fixed request scope, like tasks.test.ts / machines.test.ts. */
function buildApp(tabs: Record<string, Tab>, ownerId: string | null = null, machine: Partial<Machine> & { id: string } = { id: 'm1', type: 'local' as Machine['type'] }) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });

  const markSeen = vi.fn(async (id: string) => {
    const t = tabs[id];
    if (!t || !t.state || !['waiting_input', 'waiting_permission'].includes(t.state)) return undefined;
    if (t.state_seen_at && t.state_at && t.state_seen_at >= t.state_at) return undefined;
    tabs[id] = { ...t, state_seen_at: new Date().toISOString() };
    return tabs[id];
  });

  const tabsRepo = {
    findById: vi.fn(async (id: string) => tabs[id]),
    markSeen,
    delete: vi.fn(async (id: string) => delete tabs[id]),
  };
  const repos = {
    tabs: tabsRepo,
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id: 'p1', owner_id: 'u1' } : undefined)) },
    projectMachines: { find: vi.fn(async (p: string, m: string) => (p === 'p1' && m === machine.id ? { id: 'l1', project_id: 'p1', machine_id: m, cwd: '/tmp', position: 0, created_at: '' } : undefined)) },
    machines: { findById: vi.fn(async (id: string) => (id === machine.id ? { owner_id: 'u1', ...machine } : undefined)) },
  } as unknown as Repositories;
  const deps = { simulators: {} as never, closeSimulatorTab: vi.fn() };
  app.register((a) => tabRoutes(a, repos, deps), { prefix: '/tabs' });
  return { app, markSeen };
}

describe('POST /tabs/:id/seen', () => {
  let store: Record<string, Tab>;
  beforeEach(() => {
    store = { t1: tab({ id: 't1', state: 'waiting_input', state_at: '2026-09-19T10:00:00.000Z' }) };
  });

  it('404s for a tab outside the scope', async () => {
    const { app } = buildApp(store, 'someone-else');
    const r = await app.inject({ method: 'POST', url: '/tabs/t1/seen' });
    expect(r.statusCode).toBe(404);
  });

  it('404s for a missing tab', async () => {
    const { app } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/tabs/missing/seen' });
    expect(r.statusCode).toBe(404);
  });

  it('marks the tab seen, publishes on monitorBus, and returns 200 with the tab', async () => {
    const { app } = buildApp(store);
    const published: unknown[] = [];
    const off = monitorBus.subscribe((c) => published.push(c));
    const r = await app.inject({ method: 'POST', url: '/tabs/t1/seen' });
    off();
    expect(r.statusCode).toBe(200);
    expect(r.json().tab.state_seen_at).toBeTruthy();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
  });

  it('is idempotent: 200 with the tab, no publish, when the tab was already seen (or not waiting)', async () => {
    store.t2 = tab({ id: 't2', project_id: 'p1', state: 'idle' });
    const { app } = buildApp(store);
    const published: unknown[] = [];
    const off = monitorBus.subscribe((c) => published.push(c));
    const r = await app.inject({ method: 'POST', url: '/tabs/t2/seen' });
    off();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tab: store.t2 });
    expect(published).toHaveLength(0);
  });
});

describe('POST /tabs/:id/input', () => {
  let store: Record<string, Tab>;
  beforeEach(() => {
    store = { t1: tab({ id: 't1' }) };
    sendKeysToSession.mockReset();
  });

  it('sends text through for an agent machine — no more 409 (session-ops covers agent RPCs too)', async () => {
    sendKeysToSession.mockResolvedValue({ ok: true, error: null });
    const { app } = buildApp(store, null, { id: 'm1', type: 'agent' });
    const r = await app.inject({ method: 'POST', url: '/tabs/t1/input', payload: { text: 'echo oi', enter: true } });
    expect(r.statusCode).toBe(200);
    expect(sendKeysToSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', type: 'agent' }), 'th-t1', 'echo oi', true);
  });

  it('still reports a failure from sendKeysToSession as 409', async () => {
    sendKeysToSession.mockResolvedValue({ ok: false, error: 'tmux não respondeu' });
    const { app } = buildApp(store, null, { id: 'm1', type: 'local' });
    const r = await app.inject({ method: 'POST', url: '/tabs/t1/input', payload: { text: 'oi', enter: false } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('tmux não respondeu');
  });
});

describe('DELETE /tabs/:id', () => {
  // A visitor watching a published room must see the robot leave, not sit there until a reload.
  it('tells the public channel the tab is gone', async () => {
    const { publicBus } = await import('../public/bus.js');
    const gone: unknown[] = [];
    const off = publicBus.subscribeTabRemoved((c) => gone.push(c));
    try {
      const store = { t1: tab({ id: 't1', tmux_session: null }) };
      const { app } = buildApp(store);
      const res = await app.inject({ method: 'DELETE', url: '/tabs/t1' });
      expect(res.statusCode).toBe(200);
      expect(gone).toEqual([{ tab_id: 't1', project_id: 'p1', machine_id: 'm1' }]);
    } finally {
      off();
    }
  });
});
