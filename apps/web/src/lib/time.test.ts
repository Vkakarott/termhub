import { describe, expect, it } from 'vitest';
import { relativeTime } from './time';

describe('relativeTime', () => {
  const now = new Date('2026-09-18T12:00:00.000Z').getTime();

  it('returns "agora" for less than a minute ago', () => {
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe('agora');
    expect(relativeTime(new Date(now).toISOString(), now)).toBe('agora');
  });

  it('returns minutes for less than an hour ago', () => {
    expect(relativeTime(new Date(now - 3 * 60_000).toISOString(), now)).toBe('há 3 min');
    expect(relativeTime(new Date(now - 59 * 60_000).toISOString(), now)).toBe('há 59 min');
  });

  it('returns hours for less than a day ago', () => {
    expect(relativeTime(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe('há 2 h');
    expect(relativeTime(new Date(now - 23 * 3_600_000).toISOString(), now)).toBe('há 23 h');
  });

  it('returns days for a day or more ago', () => {
    expect(relativeTime(new Date(now - 5 * 86_400_000).toISOString(), now)).toBe('há 5 d');
  });

  it('clamps future timestamps to "agora"', () => {
    expect(relativeTime(new Date(now + 60_000).toISOString(), now)).toBe('agora');
  });
});
