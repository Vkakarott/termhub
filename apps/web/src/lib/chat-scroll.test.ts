// @vitest-environment jsdom
// Whole file runs under jsdom: isNearBottom never touches the DOM (it takes a plain object), but
// enterSends needs `window`, and one file with one honest environment beats two.
import { afterEach, describe, expect, it } from 'vitest';
import { enterSends, isNearBottom, sendsMessage } from './chat-scroll';

describe('isNearBottom', () => {
  it('is true within the slack of the bottom, false far above it', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it('brackets the default 48px slack itself, not just exact-bottom and far-away', () => {
    // 880 + 100 = 980, and 1000 - 48 = 952: 980 is short of the bottom but within the slack — the
    // real-world case of a reader a few pixels off the bottom who still counts as "following".
    expect(isNearBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    // 850 + 100 = 950 < 952: just outside the slack, from the other side of the same boundary.
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it('is true for the zero-height element jsdom gives every test', () => {
    // A list nobody has scrolled counts as at the bottom — this is what keeps "scrolls to the
    // newest message" meaningful instead of quietly inverting it.
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
  });
});

describe('enterSends', () => {
  const original = window.matchMedia;

  afterEach(() => {
    // Never let a deleted or stubbed matchMedia leak into a test elsewhere in the suite.
    window.matchMedia = original;
  });

  it('is false when the pointer is coarse (a touch keyboard)', () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('coarse') })) as typeof window.matchMedia;
    expect(enterSends()).toBe(false);
  });

  it('is true when the pointer is fine (a mouse)', () => {
    window.matchMedia = (() => ({ matches: false })) as typeof window.matchMedia;
    expect(enterSends()).toBe(true);
  });

  it('is true when matchMedia itself is unavailable', () => {
    // @ts-expect-error deleting a DOM API the real browser always has, to exercise the fallback
    delete window.matchMedia;
    expect(enterSends()).toBe(true);
  });
});

describe('sendsMessage', () => {
  const key = (over: Partial<KeyboardEvent> = {}) =>
    ({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, ...over }) as KeyboardEvent;

  afterEach(() => {
    // @ts-expect-error each test installs the pointer it needs; none may leak into the next file
    delete window.matchMedia;
  });

  const coarse = () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('coarse') })) as typeof window.matchMedia;
  };
  const fine = () => {
    window.matchMedia = (() => ({ matches: false })) as typeof window.matchMedia;
  };

  it('sends on ⌘+Enter and on Ctrl+Enter', () => {
    fine();
    expect(sendsMessage(key({ metaKey: true }))).toBe(true);
    expect(sendsMessage(key({ ctrlKey: true }))).toBe(true);
  });

  it('sends on ⌘+Enter even from a touch keyboard, where plain Enter writes a newline', () => {
    // A tablet with a hardware keyboard: Enter still has to start a line, so this is the only way to send.
    coarse();
    expect(sendsMessage(key())).toBe(false);
    expect(sendsMessage(key({ metaKey: true }))).toBe(true);
  });

  it('sends on ⌘+Enter even with Shift held, which is a newline on its own', () => {
    fine();
    expect(sendsMessage(key({ shiftKey: true }))).toBe(false);
    expect(sendsMessage(key({ metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('keeps plain Enter on the pointer rule', () => {
    fine();
    expect(sendsMessage(key())).toBe(true);
    coarse();
    expect(sendsMessage(key())).toBe(false);
  });

  it('ignores every other key, modifier or not', () => {
    fine();
    expect(sendsMessage(key({ key: 'a' }))).toBe(false);
    expect(sendsMessage(key({ key: 'a', metaKey: true }))).toBe(false);
  });
});
