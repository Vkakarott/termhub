import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/errors.js';

const { captureScreen, ensureSession, isOnline, killTmuxSession, requireAgentVersion, sendKeyToSession, sendTextToSession, waitForState } = vi.hoisted(() => ({
  captureScreen: vi.fn(),
  ensureSession: vi.fn(),
  isOnline: vi.fn(() => true),
  killTmuxSession: vi.fn(),
  requireAgentVersion: vi.fn(),
  sendKeyToSession: vi.fn(),
  sendTextToSession: vi.fn(),
  waitForState: vi.fn(),
}));
vi.mock('../agent/screen.js', () => ({ captureScreen }));
vi.mock('../agent/registry.js', () => ({ agents: { isOnline } }));
vi.mock('../agent/errors.js', () => ({ requireAgentVersion }));
vi.mock('../terminal/session-ops.js', () => ({ ensureSession, sendKeyToSession, sendTextToSession, TERMINAL_RPC_MIN_AGENT_VERSION: '0.2.0', INPUT_MAX_CHARS: 4000 }));
vi.mock('../terminal/machine-exec.js', () => ({ killTmuxSession }));
// Only waitForState is faked here; assertTerminal/clamp/offline/SCREEN_*_LINES come from the real module
// (screen.test.ts already covers waitForState's own behavior — this file only needs to control when it resolves).
vi.mock('./screen.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./screen.js')>();
  return { ...actual, waitForState };
});

const { closeTab, MAX_TABS_PER_TOKEN, openTab, runCommand, sendInput, sendKey } = await import('./terminals.js');

const machine = { id: 'm1', name: 'jarvis', type: 'agent', os: 'linux', capabilities: ['tmux'], owner_id: 'u1' };
const project = { id: 'p1', name: 'app', cwd: '/home/u/app', machine_id: 'm1', status: 'active' };
const tab = (over: Record<string, unknown> = {}) => ({ id: 't1', project_id: 'p1', name: 'Terminal 1', kind: 'terminal', tmux_session: 'termhub-p1-t1', state: null, state_text: null, state_at: null, created_by_token_id: 'tok1', ...over });

function ctxWith(over: Record<string, unknown> = {}) {
  const tabs = {
    create: vi.fn(async (_p, name) => tab({ name })),
    listByProject: vi.fn(async () => []),
    countOpenByToken: vi.fn(async () => 0),
    delete: vi.fn(async () => true),
    findById: vi.fn(async () => tab()),
    ...(over.tabs as object),
  };
  return {
    repos: { tabs },
    scope: { ownerId: 'u1', createAs: 'u1' },
    scoped: {
      project: vi.fn(async () => ({ project, machine })),
      tab: vi.fn(async () => ({ tab: (over.tab as object) ?? tab(), project, machine })),
    },
    can: vi.fn(async () => true),
    token: { id: 'tok1', scopes: ['terminals'] },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: a test that made requireAgentVersion throw would leak into the next one.
  requireAgentVersion.mockReset();
  waitForState.mockReset();
  isOnline.mockReturnValue(true);
  ensureSession.mockResolvedValue({ created: true });
});

describe('openTab', () => {
  it('creates the tab, starts its session in the project cwd and records the token', async () => {
    const ctx = ctxWith();
    const r = await openTab(ctx, { project_id: 'p1' });
    expect(ctx.repos.tabs.create).toHaveBeenCalledWith('p1', expect.stringMatching(/^[A-Z][a-z]+$/), { created_by_token_id: 'tok1' });
    expect(ensureSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', '/home/u/app');
    expect(r).toMatchObject({ tab_id: 't1', created: true });
  });

  it('stops at the per-token limit instead of filling the project with tabs', async () => {
    const ctx = ctxWith({ tabs: { countOpenByToken: vi.fn(async () => MAX_TABS_PER_TOKEN) } });
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'TAB_LIMIT' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });

  it('refuses when the machine is offline', async () => {
    isOnline.mockReturnValue(false);
    const ctx = ctxWith();
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });

  it('refuses an outdated agent before creating a tab that could not be used', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize o agente desta máquina', 'AGENT_OUTDATED');
    });
    const ctx = ctxWith();
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(ctx.repos.tabs.create).not.toHaveBeenCalled();
  });

  it('keeps the tab id in the error when the session fails to start after the row is already created', async () => {
    ensureSession.mockRejectedValue(new Error('tmux: command not found'));
    const ctx = ctxWith();
    await expect(openTab(ctx, { project_id: 'p1' })).rejects.toMatchObject({ code: 'SESSION_FAILED', message: expect.stringContaining('t1') });
    expect(ctx.repos.tabs.create).toHaveBeenCalled();
  });
});

describe('sendInput', () => {
  it('makes sure the session is there before typing', async () => {
    await sendInput(ctxWith(), { tab_id: 't1', text: 'oi', enter: true });
    expect(ensureSession).toHaveBeenCalled();
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'oi', true);
  });

  it('requests paste when the text has an embedded newline (a multi-line prompt)', async () => {
    await sendInput(ctxWith(), { tab_id: 't1', text: 'linha um\nlinha dois', enter: true });
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'linha um\nlinha dois', true, { paste: true });
  });

  it('does not request paste for single-line text', async () => {
    await sendInput(ctxWith(), { tab_id: 't1', text: 'oi', enter: true });
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'oi', true);
  });

  it('refuses a pending permission unless the caller says it is answering it', async () => {
    const ctx = ctxWith({ tab: tab({ state: 'waiting_permission', state_text: 'Permitir escrever em src/app.ts?' }) });
    await expect(sendInput(ctx, { tab_id: 't1', text: 'sim' })).rejects.toMatchObject({ code: 'WAITING_PERMISSION', message: expect.stringContaining('Permitir escrever em src/app.ts?') });
    expect(sendTextToSession).not.toHaveBeenCalled();
    await expect(sendInput(ctx, { tab_id: 't1', text: 'sim', answering_permission: true })).resolves.toMatchObject({ sent: true });
  });

  it('refuses text over the cap instead of cutting it', async () => {
    await expect(sendInput(ctxWith(), { tab_id: 't1', text: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
  });

  it('refuses a tab that is not a terminal', async () => {
    const ctx = ctxWith({ tab: tab({ kind: 'simulator', tmux_session: null }) });
    await expect(sendInput(ctx, { tab_id: 't1', text: 'oi' })).rejects.toMatchObject({ code: 'NOT_A_TERMINAL' });
  });
});

describe('sendKey', () => {
  it('presses the key in the session', async () => {
    await expect(sendKey(ctxWith(), { tab_id: 't1', key: 'C-c' })).resolves.toMatchObject({ key: 'C-c', sent: true });
    expect(sendKeyToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'C-c');
  });
});

describe('runCommand', () => {
  it('types the command, waits for the screen to settle and returns it', async () => {
    captureScreen.mockResolvedValueOnce('running…').mockResolvedValue('$ echo oi\noi\n$');
    const r = await runCommand(ctxWith(), { tab_id: 't1', command: 'echo oi', timeout_seconds: 5 });
    expect(sendTextToSession).toHaveBeenCalledWith(machine, 'termhub-p1-t1', 'echo oi', true);
    expect(r).toMatchObject({ tab_id: 't1', timed_out: false, text: '$ echo oi\noi\n$' });
  });

  it('comes back with the screen and timed_out when the command keeps going', async () => {
    let n = 0;
    captureScreen.mockImplementation(async () => `busy ${n++}`);
    const r = await runCommand(ctxWith(), { tab_id: 't1', command: 'sleep 60', timeout_seconds: 2 });
    expect(r.timed_out).toBe(true);
    expect(r.text).toContain('busy');
  });

  it('refuses a command over the cap instead of typing it', async () => {
    await expect(runCommand(ctxWith(), { tab_id: 't1', command: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('refuses a tab that is waiting on a permission, with no way to bypass it', async () => {
    const ctx = ctxWith({ tab: tab({ state: 'waiting_permission', state_text: 'Permitir rodar npm install?' }) });
    await expect(runCommand(ctx, { tab_id: 't1', command: 'npm install' })).rejects.toMatchObject({ code: 'WAITING_PERMISSION', message: expect.stringContaining('Permitir rodar npm install?') });
    expect(sendTextToSession).not.toHaveBeenCalled();
  });

  it('delegates to waitForState once the tab is already working when read', async () => {
    const ctx = ctxWith({ tab: tab({ state: 'working' }) });
    waitForState.mockResolvedValue({ tab_id: 't1', state: 'waiting_input', state_text: null, state_at: null, timed_out: false });
    captureScreen.mockResolvedValue('$ npm test\nok\n$');
    const r = await runCommand(ctx, { tab_id: 't1', command: 'npm test', timeout_seconds: 10 });
    expect(waitForState).toHaveBeenCalledWith(ctx, expect.objectContaining({ tab_id: 't1' }), undefined);
    expect(ctx.repos.tabs.findById).not.toHaveBeenCalled();
    expect(r).toMatchObject({ tab_id: 't1', state: 'waiting_input', timed_out: false });
  });

  it('waits for the hook to mark the tab working before delegating to waitForState', async () => {
    let calls = 0;
    const ctx = ctxWith({
      tab: tab({ state: 'idle' }),
      tabs: { findById: vi.fn(async () => (calls++ === 0 ? tab({ state: 'idle' }) : tab({ state: 'working' }))) },
    });
    waitForState.mockResolvedValue({ tab_id: 't1', state: 'waiting_input', state_text: null, state_at: null, timed_out: false });
    captureScreen.mockResolvedValue('$ npm test\nok\n$');
    const r = await runCommand(ctx, { tab_id: 't1', command: 'npm test', timeout_seconds: 10 });
    expect(ctx.repos.tabs.findById).toHaveBeenCalled();
    expect(waitForState).toHaveBeenCalledWith(ctx, expect.objectContaining({ tab_id: 't1' }), undefined);
    expect(r).toMatchObject({ tab_id: 't1', state: 'waiting_input', timed_out: false });
  });

  it('falls back to the screen poll when a tab with monitor state never reports working', async () => {
    const ctx = ctxWith({
      tab: tab({ state: 'idle' }),
      tabs: { findById: vi.fn(async () => tab({ state: 'idle' })) },
    });
    let n = 0;
    captureScreen.mockImplementation(async () => `busy ${n++}`);
    const r = await runCommand(ctx, { tab_id: 't1', command: 'sleep 60', timeout_seconds: 3 });
    expect(waitForState).not.toHaveBeenCalled();
    expect(r.timed_out).toBe(true);
    expect(r.text).toContain('busy');
  });
});

describe('closeTab', () => {
  it('kills the session and removes a tab this token opened', async () => {
    killTmuxSession.mockResolvedValue(true);
    await expect(closeTab(ctxWith(), { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: true });
  });

  it('refuses a tab opened somewhere else unless force is given', async () => {
    const ctx = ctxWith({ tab: tab({ created_by_token_id: null }) });
    await expect(closeTab(ctx, { tab_id: 't1' })).rejects.toMatchObject({ code: 'NOT_YOURS' });
    await expect(closeTab(ctx, { tab_id: 't1', force: true })).resolves.toMatchObject({ tab_id: 't1' });
  });

  it('still removes the tab when the session could not be killed', async () => {
    killTmuxSession.mockRejectedValue(new Error('offline'));
    const ctx = ctxWith();
    await expect(closeTab(ctx, { tab_id: 't1' })).resolves.toEqual({ tab_id: 't1', killed: false });
    expect(ctx.repos.tabs.delete).toHaveBeenCalledWith('t1');
  });
});
