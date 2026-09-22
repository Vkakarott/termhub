import { describe, expect, it } from 'vitest';
import { packShelves } from './shelves';

const box = (width: number, height: number) => ({ width, height });

describe('packShelves', () => {
  it('fills a row left to right and wraps past the target, keeping order', () => {
    const { placed, width, height } = packShelves([box(5, 3), box(5, 3), box(5, 3)], 1, 2, 12);
    expect(placed.map((p) => p.origin)).toEqual([{ gx: 0, gy: 0 }, { gx: 6, gy: 0 }, { gx: 0, gy: 5 }]);
    expect([width, height]).toEqual([11, 8]);
  });
  it('gives an item wider than the target its own row instead of looping', () => {
    const { placed } = packShelves([box(40, 3), box(5, 3)], 1, 2, 8);
    expect(placed.map((p) => p.origin)).toEqual([{ gx: 0, gy: 0 }, { gx: 0, gy: 5 }]);
  });
  it('uses the tallest item of a row for the next row', () => {
    const { placed } = packShelves([box(5, 9), box(5, 3), box(5, 3)], 1, 2, 12);
    expect(placed[2].origin).toEqual({ gx: 0, gy: 11 });
  });
  it('is empty and finite for nothing', () => {
    expect(packShelves([], 1, 2)).toEqual({ placed: [], width: 0, height: 0 });
  });
});
