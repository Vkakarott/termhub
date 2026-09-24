/* global jest */
import { signal } from './signals';

describe('signal', () => {
  it('calls every subscriber on emit, and stops once unsubscribed', () => {
    const s = signal();
    const listener = jest.fn();
    const unsubscribe = s.subscribe(listener);

    s.emit();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    s.emit();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
