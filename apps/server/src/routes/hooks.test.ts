import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { monitorBus } from '../monitor/bus.js';
import { hashHookToken, newHookToken } from '../monitor/token.js';
import { hooksRoutes } from './hooks.js';

const { token, hash } = newHookToken();
const tab: Tab = { id: 'tab1', project_id: 'p1', name: 'x', kind: 'terminal', tmux_session: 'termhub-p1-tab1', simulator_udid: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '2026-09-18T00:00:00.000Z' };

function buildApp() {
  const recordEvent = vi.fn(async (_id: string, e: { kind: Tab['state']; tool: string; text: string | null }) => ({
    tab: { ...tab, state: e.kind, state_text: e.text, state_tool: e.tool, state_at: '2026-09-18T10:00:00.000Z' },
    event: { id: 'e1', tab_id: tab.id, kind: e.kind, tool: e.tool, text: e.text, meta: {}, created_at: '2026-09-18T10:00:00.000Z' },
  }));
  const repos = {
    machineHooks: { machineIdForTokenHash: async (h: string) => (h === hash ? 'm1' : undefined) },
    tabs: { findByTmuxSession: async (machineId: string, session: string) => (machineId === 'm1' && session === tab.tmux_session ? tab : undefined), recordEvent },
    projects: { findById: async () => ({ id: 'p1', machine_id: 'm1' }) },
    machines: { findById: async () => ({ id: 'm1', owner_id: 'u1' }) },
  } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  app.register((instance) => hooksRoutes(instance, repos), { prefix: '/api/hooks' });
  return { app, recordEvent };
}

const post = (app: ReturnType<typeof Fastify>, payload: unknown, auth = `Bearer ${token}`) =>
  app.inject({ method: 'POST', url: '/api/hooks/events', payload: payload as Record<string, unknown>, headers: { authorization: auth } });

describe('POST /api/hooks/events', () => {
  it('rejects a missing, malformed or unknown token', async () => {
    const { app } = buildApp();
    expect((await post(app, {}, '')).statusCode).toBe(401);
    expect((await post(app, {}, 'Bearer nope')).statusCode).toBe(401);
    expect((await post(app, {}, `Bearer thb_hk_${'a'.repeat(43)}`)).statusCode).toBe(401);
  });

  it('records the interpreted event as the tab state and publishes it', async () => {
    const { app, recordEvent } = buildApp();
    const published: unknown[] = [];
    const off = monitorBus.subscribe((c) => published.push(c));
    const r = await post(app, { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' } });
    off();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, tab_id: 'tab1', state: 'waiting_permission' });
    expect(recordEvent).toHaveBeenCalledWith('tab1', { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?', meta: { event: 'Notification', type: 'permission_prompt' } });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ owner_id: 'u1', machine_id: 'm1', project_id: 'p1' });
  });

  it('tells the repository which event continues the wait before it, and only that one', async () => {
    const { app, recordEvent } = buildApp();
    await post(app, { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } });
    await post(app, { tool: 'codex', session: tab.tmux_session, event: { type: 'agent-turn-complete', 'last-assistant-message': 'dois' } });
    expect(recordEvent.mock.calls.map((c) => (c[1] as { continuesWait?: boolean }).continuesWait)).toEqual([true, undefined]);
  });

  it('ignores the turn Codex runs to title the conversation: the tab keeps its answer', async () => {
    const { app, recordEvent } = buildApp();
    const r = await post(app, { tool: 'codex', session: tab.tmux_session, event: { type: 'agent-turn-complete', 'thread-id': 'side', 'last-assistant-message': '{"title":"Responder apenas um"}' } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: false, reason: 'ignored' });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('answers 202 for an unknown session or an event with nothing to show', async () => {
    const { app, recordEvent } = buildApp();
    const unknown = await post(app, { tool: 'claude', session: 'not-a-tab', event: { hook_event_name: 'Stop' } });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual({ ok: false, reason: 'unknown_session' });
    const ignored = await post(app, { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'SubagentStop' } });
    expect(ignored.json()).toEqual({ ok: false, reason: 'ignored' });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('rejects before reading the body: a bad token with an oversized or invalid body is still a plain 401', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api/hooks/events', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, payload: '{not json' });
    expect(r.statusCode).toBe(401);
  });

  it('validates the body', async () => {
    const { app } = buildApp();
    expect((await post(app, { tool: 'vim', session: tab.tmux_session, event: {} })).statusCode).toBe(400);
    expect((await post(app, { tool: 'claude', session: 'bad session!', event: {} })).statusCode).toBe(400);
  });
});

describe('hook tokens', () => {
  it('are prefixed, random and hashed with sha256', () => {
    const a = newHookToken();
    const b = newHookToken();
    expect(a.token.startsWith('thb_hk_')).toBe(true);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashHookToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
