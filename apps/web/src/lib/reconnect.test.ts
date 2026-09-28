import { describe, expect, it } from 'vitest';
import { reconnectDelay } from './reconnect';

describe('reconnectDelay', () => {
  it('picks a short delay in [250, 750) for a 1012 close, regardless of the fallback', () => {
    expect(reconnectDelay(1012, 5000, () => 0)).toBe(250);
    expect(reconnectDelay(1012, 5000, () => 1)).toBe(750);
  });

  it('uses the fallback for any other close code', () => {
    expect(reconnectDelay(1006, 5000)).toBe(5000);
  });
});
