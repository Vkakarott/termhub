import { describe, expect, it, vi } from 'vitest';
import { chatBus } from './bus.js';

describe('chatBus', () => {
  it('isolates a throwing subscriber so a healthy one still gets the event and publish does not throw', () => {
    const received: unknown[] = [];
    const offThrower = chatBus.subscribe(() => {
      throw new Error('boom: closed socket / JSON.stringify failure');
    });
    const offRecorder = chatBus.subscribe((event) => received.push(event));
    try {
      const event = { type: 'message', user_id: 'u1', message: { id: 'm1' } } as never;
      expect(() => chatBus.publish(event)).not.toThrow();
      expect(received).toEqual([event]);
    } finally {
      offThrower();
      offRecorder();
    }
  });

  it('logs the thrown error instead of swallowing it silently', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = chatBus.subscribe(() => {
      throw new Error('boom');
    });
    try {
      chatBus.publish({ type: 'message', user_id: 'u1', message: { id: 'm1' } } as never);
      expect(spy).toHaveBeenCalled();
    } finally {
      off();
      spy.mockRestore();
    }
  });
});
