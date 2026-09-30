import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';

const publish = vi.fn();
vi.mock('./bus.js', () => ({ monitorBus: { publish: (...a: unknown[]) => publish(...a) } }));

const { STALE_WORKING_MS, sweepStaleWorking } = await import('./stale-working.js');

const AT = '2026-09-30T05:16:45.106Z';
const tab = (over: Partial<Tab> = {}): Tab => ({ id: 't1', project_id: 'p1', name: 't', kind: 'terminal', tmux_session: 'th-t1', state: 'working', state_tool: 'claude', state_at: AT, ...over }) as Tab;
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'm1', owner_id: 'u1', type: 'agent', ...over }) as Machine;
const log = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() });

const PROMPT = '● Pronto.\n\n✻ Brewed for 3s\n\n────────────\n❯ \n────────────';
const BUSY = '● Rodando\n\n✢ Catapulting… (14s · ↓ 145 tokens)\n\n────────────\n❯ \n────────────';
const QUESTION = ' ☐ Pet\nDo you prefer cats or dogs?\n❯ 1. Cats\n  2. Dogs\n\nEnter to select · ↑/↓ to navigate · Esc to cancel';

function setup(tabs: Tab[], screen: string, opts: { online?: boolean; machine?: Machine } = {}) {
  const recordEvent = vi.fn(async (_id: string, ev: { kind: Tab['state'] }) => ({ tab: tab({ state: ev.kind }), event: {}, rearm: null }));
  const repos = {
    tabs: { listStaleWorking: vi.fn(async () => tabs), recordEvent },
    machines: { findById: vi.fn(async () => opts.machine ?? machine()) },
  } as unknown as Repositories;
  const capture = vi.fn(async () => screen);
  const deps = { capture, isOnline: () => opts.online ?? true, checked: new Map<string, { stateAt: string; at: number }>() };
  return { repos, recordEvent, capture, deps };
}

describe('sweepStaleWorking — a tab the hooks left working (TER-615)', () => {
  const now = new Date(Date.parse(AT) + STALE_WORKING_MS + 1);

  it('asks for Claude tabs working with no event for STALE_WORKING_MS', async () => {
    const { repos, deps } = setup([], PROMPT);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(repos.tabs.listStaleWorking).toHaveBeenCalledWith(new Date(now.getTime() - STALE_WORKING_MS));
  });

  it('back at its prompt: waiting for input, only if nothing moved since the read, and it alerts', async () => {
    publish.mockClear();
    const { repos, recordEvent, capture, deps } = setup([tab()], PROMPT);
    const l = log();
    await sweepStaleWorking(repos, l as never, now, deps);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'th-t1', expect.any(Number));
    expect(recordEvent).toHaveBeenCalledWith('t1', { kind: 'waiting_input', tool: 'claude', text: null, meta: { event: 'ScreenCheck', screen: 'prompt' }, ifStateAt: AT });
    expect(publish).toHaveBeenCalledTimes(1);
    // metadata only: the screen is never logged
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', machineId: 'm1', screen: 'prompt', recorded: true }, 'monitor: stale working tab read from the screen');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('Pronto');
  });

  it('a question or a permission dialog on screen: waiting for permission, as the hooks would have said', async () => {
    const { repos, recordEvent, deps } = setup([tab()], QUESTION);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'waiting_permission', meta: { event: 'ScreenCheck', screen: 'dialog' } }));
  });

  it('a turn still running (a long build) or an unknown screen changes nothing', async () => {
    for (const screen of [BUSY, 'pedro@jarvis:~$ ']) {
      const { repos, recordEvent, deps } = setup([tab()], screen);
      await sweepStaleWorking(repos, log() as never, now, deps);
      expect(recordEvent).not.toHaveBeenCalled();
    }
  });

  it('reads a busy tab again only once STALE_WORKING_MS passed, or as soon as its state moved', async () => {
    const { repos, capture, deps } = setup([tab()], BUSY);
    await sweepStaleWorking(repos, log() as never, now, deps);
    await sweepStaleWorking(repos, log() as never, new Date(now.getTime() + 60_000), deps);
    expect(capture).toHaveBeenCalledTimes(1);
    await sweepStaleWorking(repos, log() as never, new Date(now.getTime() + STALE_WORKING_MS), deps);
    expect(capture).toHaveBeenCalledTimes(2);
    (repos.tabs.listStaleWorking as ReturnType<typeof vi.fn>).mockResolvedValueOnce([tab({ state_at: '2026-09-30T05:20:00.000Z' })]);
    await sweepStaleWorking(repos, log() as never, new Date(now.getTime() + STALE_WORKING_MS + 60_000), deps);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it('skips a machine whose agent is offline, and one capture failing does not stop the others', async () => {
    const offline = setup([tab()], PROMPT, { online: false });
    await sweepStaleWorking(offline.repos, log() as never, now, offline.deps);
    expect(offline.capture).not.toHaveBeenCalled();

    const { repos, recordEvent, capture, deps } = setup([tab({ id: 't1' }), tab({ id: 't2', tmux_session: 'th-t2' })], PROMPT);
    capture.mockRejectedValueOnce(new Error('rpc timeout'));
    const l = log();
    await sweepStaleWorking(repos, l as never, now, deps);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith('t2', expect.anything());
    expect(l.warn).toHaveBeenCalledWith(expect.objectContaining({ tabId: 't1' }), 'monitor: stale working check failed');
  });

  it('a hook that landed meanwhile wins: nothing is published', async () => {
    publish.mockClear();
    const { repos, recordEvent, deps } = setup([tab()], PROMPT);
    recordEvent.mockResolvedValueOnce({ tab: tab(), event: null, rearm: null } as never);
    await sweepStaleWorking(repos, log() as never, now, deps);
    expect(publish).not.toHaveBeenCalled();
  });
});
