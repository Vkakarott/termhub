import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/screen.js', () => ({ captureScreen: vi.fn() }));

import { captureScreen } from '../agent/screen.js';
import { AgentOfflineError } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from './context.js';
import { readScreen, waitForState } from './screen.js';

const m1 = { id: 'm1', owner_id: 'u1', type: 'agent' } as Machine;
const p1 = { id: 'p1', machine_id: 'm1' } as Project;
const baseTab = (over: Partial<Tab> = {}): Tab =>
  ({ id: 't1', project_id: 'p1', name: 't1', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, position: 0, state: 'working', state_text: null, state_tool: 'claude', state_at: '2026-09-19T10:00:00.000Z', state_seen_at: null, created_at: '', ...over }) as Tab;

function ctx(tab: Tab | undefined = baseTab()): ControlContext {
  const repos = {
    tabs: { findById: vi.fn(async (id: string) => (tab && id === tab.id ? tab : undefined)) },
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? p1 : undefined)) },
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? m1 : undefined)) },
  } as unknown as Repositories;
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  return { repos, scope, scoped: new Scoped(repos, scope), can: async () => true };
}

const publish = (tab: Tab) => monitorBus.publish({ tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
/** lets the scoped tab lookup (several awaits) finish so the wait has subscribed */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.mocked(captureScreen).mockReset());
afterEach(() => vi.useRealTimers());

describe('readScreen', () => {
  it('captures the default 200 lines and clamps to 2000', async () => {
    vi.mocked(captureScreen).mockResolvedValue('$ ls\nREADME.md\n');
    const r = await readScreen(ctx(), { tab_id: 't1' });
    expect(r).toEqual({ tab_id: 't1', lines: 200, text: '$ ls\nREADME.md\n' });
    expect(captureScreen).toHaveBeenCalledWith(m1, 'th-t1', 200);
    await readScreen(ctx(), { tab_id: 't1', lines: 99999 });
    expect(vi.mocked(captureScreen).mock.calls[1][2]).toBe(2000);
  });

  it('refuses simulator tabs, foreign tabs and reports an offline agent', async () => {
    await expect(readScreen(ctx(baseTab({ kind: 'simulator', tmux_session: null })), { tab_id: 't1' })).rejects.toThrow('Esta aba não é um terminal');
    await expect(readScreen(ctx(), { tab_id: 'nope' })).rejects.toThrow('Tab não encontrada');
    // mockRejectedValueOnce (not mockRejectedValue): with a prior mockReset() of this same mock in
    // beforeEach, vitest 3.2.7's persistent mockRejectedValue() spuriously reports this rejection as
    // an unhandled one even though it is awaited and caught right below (verified: readScreen does
    // convert it correctly). mockRejectedValueOnce avoids it and is what the rest of this codebase
    // already uses for the identical beforeEach-mockReset + reject-in-test pattern (see
    // terminal/ws.test.ts, routes/uploads.test.ts, routes/transcriptions.test.ts).
    vi.mocked(captureScreen).mockRejectedValueOnce(new AgentOfflineError('m1'));
    await expect(readScreen(ctx(), { tab_id: 't1' })).rejects.toThrow('A máquina está offline');
  });
});

describe('waitForState', () => {
  it('returns at once when the tab is not working', async () => {
    const r = await waitForState(ctx(baseTab({ state: 'waiting_input', state_text: 'Posso seguir?' })), { tab_id: 't1' });
    expect(r).toMatchObject({ tab_id: 't1', state: 'waiting_input', state_text: 'Posso seguir?', timed_out: false });
  });

  it('says there is no monitor for a tab without hook state', async () => {
    const r = await waitForState(ctx(baseTab({ state: null, state_at: null })), { tab_id: 't1' });
    expect(r).toMatchObject({ state: null, timed_out: false });
    expect(r.note).toContain('sem monitor');
  });

  it('resolves on the first change of that tab out of working, ignoring other tabs', async () => {
    const p = waitForState(ctx(), { tab_id: 't1', timeout_seconds: 5 });
    await tick();
    publish(baseTab({ id: 'other', state: 'waiting_input' }));
    publish(baseTab({ state: 'working' }));
    publish(baseTab({ state: 'waiting_permission', state_text: 'Rodar npm test?' }));
    await expect(p).resolves.toMatchObject({ state: 'waiting_permission', state_text: 'Rodar npm test?', timed_out: false });
  });

  it('times out without error and clamps the timeout to 90 s', async () => {
    vi.useFakeTimers();
    const p = waitForState(ctx(), { tab_id: 't1', timeout_seconds: 500 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(89_000);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toMatchObject({ state: 'working', timed_out: true });
  });

  it('stops listening when the caller aborts', async () => {
    const before = monitorBus.listenerCount();
    const ac = new AbortController();
    const p = waitForState(ctx(), { tab_id: 't1', timeout_seconds: 60 }, ac.signal);
    await tick();
    expect(monitorBus.listenerCount()).toBe(before + 1);
    ac.abort();
    await expect(p).resolves.toMatchObject({ timed_out: true });
    expect(monitorBus.listenerCount()).toBe(before);
  });
});
