import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorItem, Tab } from './types';
import { entersNeedsYou, needsYouByProject, needsYouText, tabDotClass } from './needs-you';
import { isTabOnScreen, setTabsOnScreen } from './visible-tabs';

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
    created_at: '2026-01-01T00:00:00Z',
    alive: true,
    ...overrides,
  };
}

const item = (t: Partial<Tab>) => ({ tab: tab(t) }) as MonitorItem;

describe('entersNeedsYou', () => {
  it('fires when the tab moves into a waiting state', () => {
    expect(entersNeedsYou('working', 'waiting_input')).toBe(true);
    expect(entersNeedsYou('idle', 'waiting_permission')).toBe(true);
    expect(entersNeedsYou(null, 'waiting_input')).toBe(true);
    expect(entersNeedsYou(undefined, 'waiting_input')).toBe(true);
  });

  it('does not fire again while it keeps waiting, nor when it leaves', () => {
    expect(entersNeedsYou('waiting_input', 'waiting_input')).toBe(false);
    expect(entersNeedsYou('waiting_input', 'waiting_permission')).toBe(false);
    expect(entersNeedsYou('waiting_input', 'working')).toBe(false);
    expect(entersNeedsYou('working', 'idle')).toBe(false);
    expect(entersNeedsYou('working', null)).toBe(false);
  });
});

describe('needsYouByProject', () => {
  it('counts the waiting tabs of each project', () => {
    const counts = needsYouByProject([
      item({ id: 'a', project_id: 'p1', state: 'waiting_input' }),
      item({ id: 'b', project_id: 'p1', state: 'waiting_permission' }),
      item({ id: 'c', project_id: 'p1', state: 'working' }),
      item({ id: 'd', project_id: 'p2', state: 'idle' }),
    ]);
    expect(counts.get('p1')).toBe(2);
    expect(counts.has('p2')).toBe(false);
  });
});

describe('tabDotClass', () => {
  it('turns the tab dot orange while the tool waits for the person', () => {
    expect(tabDotClass(true, 'waiting_input')).toContain('bg-attention');
    expect(tabDotClass(true, 'waiting_permission')).toContain('bg-attention');
  });

  it('is red on error, green when alive, grey otherwise', () => {
    expect(tabDotClass(true, 'error')).toBe('bg-danger');
    expect(tabDotClass(true, 'working')).toBe('bg-ok');
    expect(tabDotClass(true, null)).toBe('bg-ok');
    expect(tabDotClass(false, null)).toBe('bg-fg-dim');
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
