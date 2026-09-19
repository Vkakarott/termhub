import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorItem, Tab } from './types';
import { entersNeedsYou, needsYouByProject, needsYouText, shouldMarkSeen, tabDotClass, tabNeedsYou } from './needs-you';
import { isTabOnScreen, setTabsOnScreen } from './visible-tabs';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-01T00:01:00.000Z';

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    project_id: 'p1',
    name: 'claude',
    kind: 'terminal',
    tmux_session: 'th-t1',
    simulator_udid: null,
    position: 0,
    state: null,
    state_text: null,
    state_tool: 'claude',
    state_at: null,
    state_seen_at: null,
    created_at: '2026-01-01T00:00:00Z',
    alive: true,
    ...overrides,
  };
}

const item = (t: Partial<Tab>) => ({ tab: tab(t) }) as MonitorItem;

describe('tabNeedsYou', () => {
  it('is true while waiting and unseen', () => {
    expect(tabNeedsYou(tab({ state: 'waiting_input', state_at: T1 }))).toBe(true);
    expect(tabNeedsYou(tab({ state: 'waiting_permission', state_at: T1 }))).toBe(true);
  });

  it('is false once seen at or after state_at, true again when a newer state_at re-arms it', () => {
    expect(tabNeedsYou(tab({ state: 'waiting_input', state_at: T1, state_seen_at: T1 }))).toBe(false);
    expect(tabNeedsYou(tab({ state: 'waiting_input', state_at: T1, state_seen_at: T2 }))).toBe(false);
    expect(tabNeedsYou(tab({ state: 'waiting_input', state_at: T2, state_seen_at: T1 }))).toBe(true);
  });

  it('is false outside NEEDS_YOU states, or with no state_at', () => {
    expect(tabNeedsYou(tab({ state: 'working', state_at: T1 }))).toBe(false);
    expect(tabNeedsYou(tab({ state: 'idle', state_at: T1 }))).toBe(false);
    expect(tabNeedsYou(tab({ state: null, state_at: null }))).toBe(false);
    expect(tabNeedsYou(tab({ state: 'waiting_input', state_at: null }))).toBe(false);
  });
});

describe('entersNeedsYou', () => {
  it('fires when the tab starts needing you', () => {
    expect(entersNeedsYou(tab({ state: 'working' }), tab({ state: 'waiting_input', state_at: T1 }))).toBe(true);
    expect(entersNeedsYou(tab({ state: 'idle' }), tab({ state: 'waiting_permission', state_at: T1 }))).toBe(true);
    expect(entersNeedsYou(null, tab({ state: 'waiting_input', state_at: T1 }))).toBe(true);
    expect(entersNeedsYou(undefined, tab({ state: 'waiting_input', state_at: T1 }))).toBe(true);
  });

  it('does not fire while it keeps needing you, nor when it stops needing you', () => {
    const waiting = tab({ state: 'waiting_input', state_at: T1 });
    expect(entersNeedsYou(waiting, waiting)).toBe(false);
    expect(entersNeedsYou(waiting, tab({ state: 'waiting_permission', state_at: T1 }))).toBe(false);
    expect(entersNeedsYou(waiting, tab({ state: 'working' }))).toBe(false);
    expect(entersNeedsYou(tab({ state: 'working' }), tab({ state: 'idle' }))).toBe(false);
    expect(entersNeedsYou(tab({ state: 'working' }), null)).toBe(false);
  });

  it('does not fire when a needs-you tab is seen (goes from needs-you to seen)', () => {
    const waiting = tab({ state: 'waiting_input', state_at: T1 });
    const seen = tab({ state: 'waiting_input', state_at: T1, state_seen_at: T1 });
    expect(entersNeedsYou(waiting, seen)).toBe(false);
  });

  it('fires again when a new event re-arms a seen tab (seen, then a newer state_at)', () => {
    const seen = tab({ state: 'waiting_input', state_at: T1, state_seen_at: T1 });
    const rearmed = tab({ state: 'waiting_permission', state_at: T2, state_seen_at: T1 });
    expect(entersNeedsYou(seen, rearmed)).toBe(true);
  });
});

describe('needsYouByProject', () => {
  it('counts the waiting-and-unseen tabs of each project', () => {
    const counts = needsYouByProject([
      item({ id: 'a', project_id: 'p1', state: 'waiting_input', state_at: T1 }),
      item({ id: 'b', project_id: 'p1', state: 'waiting_permission', state_at: T1 }),
      item({ id: 'c', project_id: 'p1', state: 'working' }),
      item({ id: 'd', project_id: 'p2', state: 'idle' }),
      item({ id: 'e', project_id: 'p1', state: 'waiting_input', state_at: T1, state_seen_at: T1 }),
    ]);
    expect(counts.get('p1')).toBe(2);
    expect(counts.has('p2')).toBe(false);
  });
});

describe('tabDotClass', () => {
  it('turns the tab dot orange while the tool waits for the person, unseen', () => {
    expect(tabDotClass(true, tab({ state: 'waiting_input', state_at: T1 }))).toContain('bg-attention');
    expect(tabDotClass(true, tab({ state: 'waiting_permission', state_at: T1 }))).toContain('bg-attention');
  });

  it('is not orange once the tab has been seen', () => {
    expect(tabDotClass(true, tab({ state: 'waiting_input', state_at: T1, state_seen_at: T1 }))).toBe('bg-ok');
  });

  it('is red on error, green when alive, grey otherwise', () => {
    expect(tabDotClass(true, tab({ state: 'error' }))).toBe('bg-danger');
    expect(tabDotClass(true, tab({ state: 'working' }))).toBe('bg-ok');
    expect(tabDotClass(true, null)).toBe('bg-ok');
    expect(tabDotClass(false, null)).toBe('bg-fg-dim');
    expect(tabDotClass(false, undefined)).toBe('bg-fg-dim');
  });
});

describe('needsYouText', () => {
  it('prefers what the tool said', () => {
    expect(needsYouText(tab({ state: 'waiting_input', state_text: 'Posso seguir?' }))).toBe('Posso seguir?');
  });

  it('falls back to a line per state', () => {
    expect(needsYouText(tab({ state: 'waiting_input' }))).toBe('terminou e está esperando você');
    expect(needsYouText(tab({ state: 'waiting_permission' }))).toBe('está pedindo permissão');
  });
});

describe('shouldMarkSeen', () => {
  const waitingUnseen = tab({ state: 'waiting_input', state_at: T1 });

  it('is true only when the tab needs you, the view is visible and the window is active', () => {
    expect(shouldMarkSeen(waitingUnseen, { viewVisible: true, windowActive: true })).toBe(true);
  });

  it('is false while the terminals view is not visible', () => {
    expect(shouldMarkSeen(waitingUnseen, { viewVisible: false, windowActive: true })).toBe(false);
  });

  it('is false while the browser window is not visible/focused', () => {
    expect(shouldMarkSeen(waitingUnseen, { viewVisible: true, windowActive: false })).toBe(false);
  });

  it('is false when the tab is not waiting', () => {
    expect(shouldMarkSeen(tab({ state: 'working' }), { viewVisible: true, windowActive: true })).toBe(false);
  });

  it('is false when the tab is already seen', () => {
    const seen = tab({ state: 'waiting_input', state_at: T1, state_seen_at: T1 });
    expect(shouldMarkSeen(seen, { viewVisible: true, windowActive: true })).toBe(false);
  });
});

describe('visible tabs', () => {
  afterEach(() => {
    setTabsOnScreen('p1', []);
    setTabsOnScreen('p2', []);
  });

  it('knows which tabs are on screen per project', () => {
    setTabsOnScreen('p1', ['a', 'b']);
    setTabsOnScreen('p2', ['c']);
    expect(isTabOnScreen('a')).toBe(true);
    expect(isTabOnScreen('c')).toBe(true);
    setTabsOnScreen('p1', []);
    expect(isTabOnScreen('a')).toBe(false);
    expect(isTabOnScreen('c')).toBe(true);
  });
});
