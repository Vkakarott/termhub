import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlidingWindow } from './rate-limit.js';

describe('SlidingWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to max takes per key within the window, then refuses', () => {
    const w = new SlidingWindow(10_000, 3);
    expect(w.take('k')).toBe(true);
    expect(w.take('k')).toBe(true);
    expect(w.take('k')).toBe(true);
    expect(w.take('k')).toBe(false);
  });

  it('tracks keys independently', () => {
    const w = new SlidingWindow(10_000, 3);
    w.take('k');
    w.take('k');
    w.take('k');
    expect(w.take('k')).toBe(false);
    expect(w.take('other')).toBe(true);
  });

  it('resets once the window has fully elapsed', () => {
    const w = new SlidingWindow(10_000, 3);
    w.take('k');
    w.take('k');
    w.take('k');
    expect(w.take('k')).toBe(false);
    vi.advanceTimersByTime(10_001);
    expect(w.take('k')).toBe(true);
  });

  it('clears the whole map once it grows past 10,000 keys', () => {
    const w = new SlidingWindow(10_000, 3);
    w.take('old-key');
    expect(w.peek('old-key')).toBe(1);
    for (let i = 0; i < 10_001; i++) {
      w.take(`key-${i}`);
    }
    expect(w.peek('old-key')).toBe(0);
  });
});
