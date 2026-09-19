// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConsent, subscribeConsent, writeConsent } from './consent';

afterEach(() => {
  localStorage.clear();
});

describe('consent', () => {
  it('is null until the user answers', () => {
    expect(readConsent()).toBeNull();
  });

  it('persists the choice', () => {
    writeConsent('granted');
    expect(readConsent()).toBe('granted');
    writeConsent('denied');
    expect(readConsent()).toBe('denied');
  });

  it('ignores a corrupted stored value', () => {
    localStorage.setItem('termhub:consent', '{"value":"maybe"}');
    expect(readConsent()).toBeNull();
    localStorage.setItem('termhub:consent', 'not json');
    expect(readConsent()).toBeNull();
  });

  it('notifies subscribers of a new choice until they unsubscribe', () => {
    const cb = vi.fn();
    const off = subscribeConsent(cb);
    writeConsent('granted');
    expect(cb).toHaveBeenCalledWith('granted');
    off();
    writeConsent('denied');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
