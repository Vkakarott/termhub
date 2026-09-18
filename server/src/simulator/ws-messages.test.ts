import { describe, expect, it } from 'vitest';
import { clientMessageSchema } from './ws-messages.js';

describe('clientMessageSchema', () => {
  it('aceita as mensagens válidas', () => {
    for (const m of [
      { type: 'tap', x: 1, y: 2 },
      { type: 'drag', points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 16 }] },
      { type: 'keys', text: 'olá' },
      { type: 'key', name: 'Enter' },
      { type: 'button', name: 'home' },
      { type: 'rotate', orientation: 'landscape' },
      { type: 'settings', scale: 25, quality: 30 },
      { type: 'pause' },
      { type: 'resume' },
      { type: 'ping' },
    ]) expect(clientMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });

  it('rejeita fora dos limites', () => {
    expect(clientMessageSchema.safeParse({ type: 'settings', scale: 5, quality: 30 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'button', name: 'power' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'keys', text: 'x'.repeat(5000) }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'drag', points: [] }).success).toBe(false);
  });
});
