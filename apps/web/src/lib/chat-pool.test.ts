import { describe, expect, it } from 'vitest';
import { dropAlive, MAX_ALIVE_CHATS, touchAlive } from './chat-pool';

describe('touchAlive', () => {
  it('puts the id first and keeps at most max ids', () => {
    expect(MAX_ALIVE_CHATS).toBe(3);
    let a: string[] = [];
    a = touchAlive(a, 'p1');
    a = touchAlive(a, 'p2');
    a = touchAlive(a, 'p3');
    expect(a).toEqual(['p3', 'p2', 'p1']);
    a = touchAlive(a, 'p4');
    expect(a).toEqual(['p4', 'p3', 'p2']);
    a = touchAlive(a, 'p2');
    expect(a).toEqual(['p2', 'p4', 'p3']);
  });

  it('returns the same array when the id is already first', () => {
    const a = ['p1', 'p2'];
    expect(touchAlive(a, 'p1')).toBe(a);
  });
});

describe('dropAlive', () => {
  it('removes the id, and returns the same array when it is not there', () => {
    const a = ['p1', 'p2'];
    expect(dropAlive(a, 'p1')).toEqual(['p2']);
    expect(dropAlive(a, 'p9')).toBe(a);
  });
});
