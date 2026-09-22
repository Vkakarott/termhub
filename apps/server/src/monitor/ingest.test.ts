import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));

const { ingestHookEvent } = await import('./ingest.js');

const tab = (over: Partial<Tab>): Tab => ({ id: 't1', project_id: 'p1', name: 't', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, created_by_token_id: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, activity: null, created_at: '', ...over }) as Tab;
const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as never;

function repos(current: Tab) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: string; activity?: string }) => ({ tab: tab({ ...current, state: ev.kind as Tab['state'], activity: (ev.activity as Tab['activity']) ?? null }), event: {} }));
  const setActivity = vi.fn(async (_id: string, activity: Tab['activity']) => tab({ ...current, activity }));
  return {
    r: { tabs: { findByTmuxSession: vi.fn(async () => current), recordEvent, setActivity }, projects: { findById: vi.fn(async () => ({ id: 'p1', machine_id: 'm1' })) }, machines: { findById: vi.fn(async () => ({ id: 'm1', owner_id: 'u1' })) } } as unknown as Repositories,
    recordEvent,
    setActivity,
  };
}
const pre = (tool_name: string) => ({ machineId: 'm1', tool: 'claude' as const, session: 'th-t1', event: { hook_event_name: 'PreToolUse', tool_name } });

describe('ingestHookEvent — activity', () => {
  it('records an event when the state changes, carrying the activity', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'waiting_input' }));
    const res = await ingestHookEvent(r, log, pre('Edit'));
    expect(res).toMatchObject({ ok: true, tab: { state: 'working', activity: 'coding' } });
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'working', activity: 'coding' }));
    expect(setActivity).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it('takes the light path when only the activity changes on a working tab', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'coding' }));
    const res = await ingestHookEvent(r, log, pre('Read'));
    expect(res).toMatchObject({ ok: true, tab: { activity: 'reading' } });
    expect(setActivity).toHaveBeenCalledWith('t1', 'reading');
    expect(recordEvent).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the activity is already stored', async () => {
    publish.mockClear();
    const { r, recordEvent, setActivity } = repos(tab({ state: 'working', activity: 'coding' }));
    const res = await ingestHookEvent(r, log, pre('Write'));
    expect(res).toMatchObject({ ok: true });
    expect(setActivity).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('never logs the tool input', async () => {
    const { r } = repos(tab({ state: 'waiting_input' }));
    await ingestHookEvent(r, log, { ...pre('Edit'), event: { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/secret' } } });
    const logged = JSON.stringify((log as { info: { mock: { calls: unknown[] } } }).info.mock.calls);
    expect(logged).not.toContain('secret');
  });
});
