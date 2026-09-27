import { describe, expect, it } from 'vitest';
import { CHAT_DEFAULT_WIDTH, CHAT_PREFS_KEY, clampChatWidth, DEFAULT_CHAT_PREF, loadChatPrefs, prefOf, saveChatPrefs, withPref } from './project-chat-prefs';

/** A Storage stand-in: a Map, and a switch that makes every call throw (blocked or full storage). */
function memoryStorage(initial: Record<string, string> = {}, broken = false): Storage {
  const m = new Map(Object.entries(initial));
  const guard = () => {
    if (broken) throw new Error('blocked');
  };
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (guard(), m.get(k) ?? null),
    setItem: (k, v) => (guard(), void m.set(k, v)),
    removeItem: (k) => void m.delete(k),
  };
}

describe('clampChatWidth', () => {
  it('keeps a width inside 320–720, clamps outside, and defaults a non-number to 420', () => {
    expect(clampChatWidth(500)).toBe(500);
    expect(clampChatWidth(100)).toBe(320);
    expect(clampChatWidth(99999)).toBe(720);
    expect(clampChatWidth(450.7)).toBe(450);
    expect(clampChatWidth('abc')).toBe(CHAT_DEFAULT_WIDTH);
    expect(clampChatWidth(Number.NaN)).toBe(CHAT_DEFAULT_WIDTH);
    expect(clampChatWidth(undefined)).toBe(CHAT_DEFAULT_WIDTH);
  });
});

describe('loadChatPrefs', () => {
  it('reads and sanitizes each entry', () => {
    const s = memoryStorage({
      [CHAT_PREFS_KEY]: JSON.stringify({
        p1: { open: true, width: 500, maximized: false },
        p2: { open: 'yes', width: 5, maximized: 1 },
        p3: 'garbage',
      }),
    });
    expect(loadChatPrefs(s)).toEqual({
      p1: { open: true, width: 500, maximized: false },
      p2: { open: false, width: 320, maximized: false },
    });
  });

  it.each(['null', '[]', '"x"', '{not json', '42'])('falls back to no entries for %s', (raw) => {
    expect(loadChatPrefs(memoryStorage({ [CHAT_PREFS_KEY]: raw }))).toEqual({});
  });

  it('falls back to no entries when storage throws', () => {
    expect(loadChatPrefs(memoryStorage({}, true))).toEqual({});
  });
});

describe('saveChatPrefs', () => {
  it('writes JSON under the key', () => {
    const s = memoryStorage();
    saveChatPrefs({ p1: { open: true, width: 400, maximized: true } }, s);
    expect(JSON.parse(s.getItem(CHAT_PREFS_KEY)!)).toEqual({ p1: { open: true, width: 400, maximized: true } });
  });

  it('swallows a blocked storage', () => {
    expect(() => saveChatPrefs({}, memoryStorage({}, true))).not.toThrow();
  });
});

describe('prefOf / withPref', () => {
  it('defaults an unknown project to closed, 420, not maximized', () => {
    expect(prefOf({}, 'p9')).toEqual(DEFAULT_CHAT_PREF);
    expect(DEFAULT_CHAT_PREF).toEqual({ open: false, width: 420, maximized: false });
  });

  it('patches one project without touching others, clamping the width', () => {
    const before = { p1: { open: true, width: 500, maximized: false } };
    const after = withPref(before, 'p2', { open: true, width: 10 });
    expect(after).toEqual({ p1: before.p1, p2: { open: true, width: 320, maximized: false } });
    expect(before).toEqual({ p1: { open: true, width: 500, maximized: false } });
  });
});
