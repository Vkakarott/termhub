import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { STATE_TEXT_MAX } from '../monitor/state.js';
import { chatBus, type ChatEvent } from './bus.js';

const captureStyledScreen = vi.fn();
vi.mock('../agent/screen.js', async (orig) => ({ ...(await orig<typeof import('../agent/screen.js')>()), captureStyledScreen: (...a: unknown[]) => captureStyledScreen(...a) }));

const { CLAUDE_IDLE_MESSAGE, SUGGESTION_DELAY_MS, cancelTabSuggestion, checkTabSuggestion, cleanContext, cleanSuggestion, openCodexReply, scheduleTabSuggestion, stopTabSuggestions } = await import('./tab-suggestions.js');

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/tab-suggestions', name), 'utf8');
const screens = { suggestion: fx('screen-suggestion.ansi'), typed: fx('screen-typed.ansi') };

const CONTEXT = 'Criei o notes.txt.\n\nQuer que eu faça o commit?';
const STOP = { context: CONTEXT, backgroundTasks: 0 };
const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api', kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_input', state_tool: 'claude', state_text: CONTEXT };
const machine = { id: 'm1', type: 'agent', owner_id: 'u1' };
const opened = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 's1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null,
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', suggestion: null, ...over,
});

function fakeRepos(opts: { tab?: object | undefined; conversation?: object | null; codexReplies?: boolean } = {}) {
  const t = 'tab' in opts ? opts.tab : tab;
  const conversation = opts.conversation === undefined ? { id: 'c1', user_id: 'u1' } : (opts.conversation ?? undefined);
  return {
    tabs: { findById: vi.fn(async () => t), findByIdsForOwner: vi.fn(async () => [tab]) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    chat: { findLatestActiveForProject: vi.fn(async () => conversation) },
    machines: { findById: vi.fn(async () => machine) },
    tabQuestions: { open: vi.fn(async () => ({ question: opened(), closed: [] as TabQuestion[] })) },
    users: { chatCodexReplies: vi.fn(async () => opts.codexReplies ?? true) },
  };
}
const asRepos = (r: ReturnType<typeof fakeRepos>) => r as unknown as Repositories;
const log = () => ({ info: vi.fn(), warn: vi.fn() });
/** Only setTimeout is faked: setImmediate stays real, so `settle` lets every resolved mock run. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

let events: ChatEvent[];
let unsubscribe: () => void;
beforeEach(() => {
  captureStyledScreen.mockReset();
  captureStyledScreen.mockResolvedValue({ text: screens.suggestion, styled: true });
  vi.spyOn(agents, 'isOnline').mockReturnValue(true);
  events = [];
  unsubscribe = chatBus.subscribe((e) => events.push(e));
});
afterEach(() => {
  unsubscribe();
  stopTabSuggestions();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cleanSuggestion', () => {
  it('keeps one line of plain text, capped at 2000', () => {
    expect(cleanSuggestion('  commit\u0007 it ')).toBe('commit it');
    expect(cleanSuggestion('x'.repeat(2500))).toHaveLength(2000);
    expect(cleanSuggestion('\u0001 ')).toBeNull();
    expect(cleanSuggestion(null)).toBeNull();
  });

  it('strips C1 too, and never splits a surrogate pair at the cap', () => {
    expect(cleanSuggestion('commit\u009b it\u0085')).toBe('commit it');
    expect(cleanSuggestion(`${'x'.repeat(1999)}😀`)).toBe('x'.repeat(1999));
  });
});

describe('checkTabSuggestion', () => {
  it("opens a suggestion row in the project's latest conversation and announces it on its own event", async () => {
    const repos = fakeRepos();
    const l = log();
    await checkTabSuggestion(asRepos(repos), l, 't1', CONTEXT);
    expect(captureStyledScreen).toHaveBeenCalledWith(machine, 'th-t1', 15);
    expect(repos.chat.findLatestActiveForProject).toHaveBeenCalledWith('p1', 'u1');
    expect(repos.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: 'c1', kind: 'suggestion', payload: { text: 'commit it', context: CONTEXT }, tool_use_id: null, agent_id: null });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion', user_id: 'u1', conversation_id: 'c1', suggestion: expect.objectContaining({ id: 's1', tab_name: 'api', kind: 'suggestion' }) })]);
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', tabQuestionId: 's1', kind: 'suggestion', chars: 9, contextChars: CONTEXT.length }, 'tab suggestion opened');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('commit');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('notes');
  });

  it.each([
    ['text the person typed', { text: screens.typed, styled: true }],
    ['an older agent (plain capture)', { text: 'x\n❯ commit it\n', styled: false }],
    // Seen live (Claude Code 2.1.283): "/compact" as the suggestion. Sending refuses a leading / or !,
    // so such a card could only fail.
    ['a slash command', { text: 'x\n\x1b[39m❯ \x1b[2m/compact\x1b[0m\n', styled: true }],
    ['a bash command', { text: 'x\n\x1b[39m❯ \x1b[2m!git status\x1b[0m\n', styled: true }],
    ['a spaced bash command', { text: 'x\n\x1b[39m❯ \x1b[2m! git status\x1b[0m\n', styled: true }],
  ])('opens nothing for %s', async (_label, shot) => {
    captureStyledScreen.mockResolvedValue(shot);
    const repos = fakeRepos();
    await checkTabSuggestion(asRepos(repos), log(), 't1', CONTEXT);
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('reads nothing when the tab is gone or busy again, the project has no conversation, or the agent is offline', async () => {
    await checkTabSuggestion(asRepos(fakeRepos({ tab: undefined })), log(), 't1', CONTEXT);
    await checkTabSuggestion(asRepos(fakeRepos({ tab: { ...tab, state: 'working' } })), log(), 't1', CONTEXT);
    await checkTabSuggestion(asRepos(fakeRepos({ conversation: null })), log(), 't1', CONTEXT);
    vi.mocked(agents.isOnline).mockReturnValue(false);
    await checkTabSuggestion(asRepos(fakeRepos()), log(), 't1', CONTEXT);
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('opens nothing when the tab moved while its screen was read', async () => {
    const repos = fakeRepos();
    await checkTabSuggestion(asRepos(repos), log(), 't1', CONTEXT, () => false);
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });

  it('never throws, and logs by code only', async () => {
    captureStyledScreen.mockRejectedValueOnce(Object.assign(new Error('❯ commit it'), { code: 'MACHINE_FAILED' }));
    const l = log();
    await expect(checkTabSuggestion(asRepos(fakeRepos()), l, 't1', CONTEXT)).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith({ tabId: 't1', code: 'MACHINE_FAILED' }, 'tab suggestion check failed');
  });
});

describe('scheduleTabSuggestion', () => {
  it('waits 5 s: the suggestion was seen drawn 1.5–2.8 s after the Stop', () => {
    expect(SUGGESTION_DELAY_MS).toBe(5000);
  });

  it(`reads the prompt ${SUGGESTION_DELAY_MS} ms after the Stop, not before`, async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', STOP);
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS - 1);
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
  });

  it('any event of the tab meanwhile cancels it', async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', STOP);
    await vi.advanceTimersByTimeAsync(1000);
    cancelTabSuggestion('t1');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
  });

  it("a second Stop restarts the wait; another tab's event does not touch it", async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', STOP);
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS - 1000);
    scheduleTabSuggestion(asRepos(repos), log(), 't1', STOP);
    cancelTabSuggestion('t2');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS - 1);
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
  });

  it('an event that arrives while the screen is being read keeps the row from opening', async () => {
    fakeTimers();
    let release!: (v: unknown) => void;
    captureStyledScreen.mockReturnValue(new Promise((r) => (release = r)));
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', STOP);
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS);
    await settle();
    expect(captureStyledScreen).toHaveBeenCalled();
    cancelTabSuggestion('t1');
    release({ text: screens.suggestion, styled: true });
    await settle();
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });

  it('stopTabSuggestions: a scheduled check never runs after it', async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', STOP);
    scheduleTabSuggestion(asRepos(repos), log(), 't2', STOP);
    stopTabSuggestions();
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS * 2);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });
});

describe('cleanContext (spec 2026-09-26 §6.2)', () => {
  it('keeps the message as written: newlines kept, other controls and bidi removed, long blank runs collapsed', () => {
    expect(cleanContext('Feito.\r\n\r\n\r\n\r\n‮Quer\tque eu\u0085 faça o commit?​')).toBe('Feito.\n\n\nQuer que eu faça o commit?');
    expect(cleanContext('a\n\n\nb')).toBe('a\n\n\nb'); // two blank lines stay
  });

  it('caps at STATE_TEXT_MAX without splitting a pair', () => {
    expect(cleanContext('x'.repeat(2500))).toHaveLength(2000);
    expect(cleanContext(`${'x'.repeat(1999)}😀tail`)).toBe('x'.repeat(1999));
  });

  it("is null for no text, blank text, or Claude's generic idle message", () => {
    expect(cleanContext(null)).toBeNull();
    expect(cleanContext(' \n​ ')).toBeNull();
    expect(cleanContext(CLAUDE_IDLE_MESSAGE)).toBeNull();
    expect(CLAUDE_IDLE_MESSAGE).toBe('Claude is waiting for your input');
  });
});

describe('checkTabSuggestion — context and old agents', () => {
  it.each([
    ['older than 0.5.2: no capture at all', '0.5.1', 0],
    ['0.5.2: captures', '0.5.2', 1],
    ['newer: captures', '0.5.3', 1],
  ])('an agent %s', async (_label, version, captures) => {
    vi.spyOn(agents, 'info').mockReturnValue({ agent_version: version, os: 'linux', tools: [], connected_at: '2026-09-26T00:00:00.000Z' });
    await checkTabSuggestion(asRepos(fakeRepos()), log(), 't1', CONTEXT);
    expect(captureStyledScreen).toHaveBeenCalledTimes(captures);
  });

  it('an agent whose version is unknown still tries (its plain answer opens nothing)', async () => {
    vi.spyOn(agents, 'info').mockReturnValue(null);
    await checkTabSuggestion(asRepos(fakeRepos()), log(), 't1', CONTEXT);
    expect(captureStyledScreen).toHaveBeenCalledTimes(1);
  });
});

describe('the Stop decides (spec 2026-09-26 TER-203 §4.2)', () => {
  it("stores the Stop's message whatever the tab row says by then", async () => {
    const repos = fakeRepos({ tab: { ...tab, state_text: CLAUDE_IDLE_MESSAGE, state_tool: 'codex' } });
    await checkTabSuggestion(asRepos(repos), log(), 't1', CONTEXT);
    expect(repos.tabQuestions.open).toHaveBeenCalledWith(expect.objectContaining({ payload: { text: 'commit it', context: CONTEXT } }));
  });

  it('schedules with the cleaned message', async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', { context: ' Pronto.\u0007\n\nQuer o commit? ', backgroundTasks: 0 });
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS);
    await settle();
    expect(repos.tabQuestions.open).toHaveBeenCalledWith(expect.objectContaining({ payload: { text: 'commit it', context: 'Pronto.\n\nQuer o commit?' } }));
  });

  it('running background work: no timer, no capture, a reason in the log', async () => {
    fakeTimers();
    const repos = fakeRepos();
    const l = log();
    scheduleTabSuggestion(asRepos(repos), l, 't1', { context: CONTEXT, backgroundTasks: 2 });
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS * 2);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    expect(captureStyledScreen).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', reason: 'background', count: 2 }, 'tab suggestion skipped');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('commit');
  });

  it.each([
    ['no message (a Stop without last_assistant_message)', null],
    ['a blank message', ' \n​ '],
    ["Claude's idle reminder", CLAUDE_IDLE_MESSAGE],
  ])('%s: no timer, reason no_context', async (_label, context) => {
    fakeTimers();
    const repos = fakeRepos();
    const l = log();
    scheduleTabSuggestion(asRepos(repos), l, 't1', { context, backgroundTasks: 0 });
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS * 2);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', reason: 'no_context' }, 'tab suggestion skipped');
  });

  it('a skipped Stop still cancels the pending check of an earlier one', async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', STOP);
    await vi.advanceTimersByTimeAsync(1000);
    scheduleTabSuggestion(asRepos(repos), log(), 't1', { context: null, backgroundTasks: 0 });
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS * 2);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });
});

describe('openCodexReply', () => {
  const codexTab = { ...tab, state_tool: 'codex' };
  const ask = 'Criei o notes.txt.\n\nQuer que eu faça o commit?';

  it('opens a suggestion row with an empty text, the cleaned context and agent codex, and publishes it', async () => {
    const r = fakeRepos({ tab: codexTab });
    const l = log();
    await openCodexReply(asRepos(r), l, 't1', ask);
    expect(r.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: 'c1', kind: 'suggestion', payload: { text: '', context: ask, agent: 'codex' }, tool_use_id: null, agent_id: null });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion', conversation_id: 'c1' })]);
    expect(captureStyledScreen).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith(expect.objectContaining({ tabId: 't1', kind: 'suggestion' }), 'codex reply card opened');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('commit');
  });

  it.each([
    ['ends in a statement', 'Pronto, criei o arquivo.'],
    ['asks in the middle only', 'Quer que eu rode?\n\nDepois eu aviso.'],
    ['is blank', '   '],
  ])('opens nothing when the message %s', async (_l, text) => {
    const r = fakeRepos({ tab: codexTab });
    await openCodexReply(asRepos(r), log(), 't1', text);
    expect(r.tabQuestions.open).not.toHaveBeenCalled();
  });

  it('accepts a fullwidth question mark and trailing whitespace', async () => {
    const r = fakeRepos({ tab: codexTab });
    await openCodexReply(asRepos(r), log(), 't1', '実行しますか？  \n');
    expect(r.tabQuestions.open).toHaveBeenCalledTimes(1);
  });

  it('opens nothing without a conversation, or when the tab no longer waits', async () => {
    const none = fakeRepos({ tab: codexTab, conversation: null });
    await openCodexReply(asRepos(none), log(), 't1', ask);
    expect(none.tabQuestions.open).not.toHaveBeenCalled();
    const moved = fakeRepos({ tab: { ...codexTab, state: 'working' } });
    await openCodexReply(asRepos(moved), log(), 't1', ask);
    expect(moved.tabQuestions.open).not.toHaveBeenCalled();
  });

  it('opens nothing while the owner has the Codex reply switch off (the default)', async () => {
    const r = fakeRepos({ tab: codexTab, codexReplies: false });
    await openCodexReply(asRepos(r), log(), 't1', ask);
    expect(r.users.chatCodexReplies).toHaveBeenCalledWith('u1');
    expect(r.tabQuestions.open).not.toHaveBeenCalled();
  });

  describe('a message longer than STATE_TEXT_MAX', () => {
    const opened = (r: ReturnType<typeof fakeRepos>) => (r.tabQuestions.open.mock.calls[0]![0] as { payload: { context: string } }).payload.context;

    it('opens on the question of its last paragraph and keeps its tail, cut on a paragraph boundary', async () => {
      const paragraphs = Array.from({ length: 40 }, (_, i) => `Parágrafo ${i}: ${'x'.repeat(80)}`);
      const message = `${paragraphs.join('\n\n')}\n\nQuer que eu faça o commit?`;
      expect(message.length).toBeGreaterThan(STATE_TEXT_MAX);
      const r = fakeRepos({ tab: codexTab });
      await openCodexReply(asRepos(r), log(), 't1', message);
      expect(r.tabQuestions.open).toHaveBeenCalledTimes(1);
      const context = opened(r);
      expect(context.length).toBeLessThanOrEqual(STATE_TEXT_MAX);
      expect(context.endsWith('Quer que eu faça o commit?')).toBe(true);
      expect(context).not.toContain('Parágrafo 0:');
      // starts on a whole paragraph: the one after the boundary the cut found
      expect(context).toMatch(/^Parágrafo \d+: x/);
      expect(message.endsWith(context)).toBe(true);
    });

    it('cuts inside a paragraph with no boundary without splitting a surrogate pair, marking the cut', async () => {
      const message = `${'😀'.repeat(STATE_TEXT_MAX)} Posso seguir?`;
      const r = fakeRepos({ tab: codexTab });
      await openCodexReply(asRepos(r), log(), 't1', message);
      const context = opened(r);
      expect(context.length).toBeLessThanOrEqual(STATE_TEXT_MAX);
      expect(context.startsWith('…')).toBe(true);
      expect(context.endsWith('Posso seguir?')).toBe(true);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(context)).toBe(false);
    });

    it('opens nothing when only its start asks', async () => {
      const r = fakeRepos({ tab: codexTab });
      await openCodexReply(asRepos(r), log(), 't1', `Rodo os testes?\n\n${'y'.repeat(STATE_TEXT_MAX * 2)}`);
      expect(r.tabQuestions.open).not.toHaveBeenCalled();
    });
  });

  it('never throws; logs the code only', async () => {
    const r = fakeRepos({ tab: codexTab });
    r.tabQuestions.open.mockRejectedValue(new Error('boom Quer que eu'));
    const l = log();
    await expect(openCodexReply(asRepos(r), l, 't1', ask)).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith(expect.objectContaining({ tabId: 't1' }), 'codex reply card failed');
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('Quer que');
  });
});
