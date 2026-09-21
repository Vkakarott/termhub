// @vitest-environment jsdom
// Whole file runs under jsdom: isNearBottom never touches the DOM (it takes a plain object), but
// enterSends needs `window`, and one file with one honest environment beats two.
import { afterEach, describe, expect, it } from 'vitest';
import { enterSends, isNearBottom } from './chat-scroll';

describe('isNearBottom', () => {
  it('is true within the slack of the bottom, false far above it', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
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
