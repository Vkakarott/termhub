import { describe, expect, it } from 'vitest';
import { decodeGroupDrag, decodeProjectDrag, encodeProjectDrag, slotFor } from './sidebar-dnd';

describe('project drag payload', () => {
  it('round-trips', () => {
    expect(decodeProjectDrag(encodeProjectDrag({ projectId: 'p1', from: 'g1' }))).toEqual({ projectId: 'p1', from: 'g1' });
  });

  it('rejects garbage', () => {
    for (const raw of ['', '{', '{}', '{"projectId":1}', '{"projectId":"p1"}', '{"projectId":"p1","from":2}', 'null', '"x"']) {
      expect(decodeProjectDrag(raw)).toBeNull();
    }
  });
});

describe('group drag payload', () => {
  it('reads a group id and rejects an empty one', () => {
    expect(decodeGroupDrag('g1')).toBe('g1');
    expect(decodeGroupDrag('')).toBeNull();
  });
});

describe('slotFor', () => {
  const rect = { top: 100, height: 20 };
  it('is the row itself in its top half and the next slot in its bottom half', () => {
    expect(slotFor(3, 100, rect)).toBe(3);
    expect(slotFor(3, 109, rect)).toBe(3);
    expect(slotFor(3, 110, rect)).toBe(4);
    expect(slotFor(3, 119, rect)).toBe(4);
  });
});
