import { describe, expect, it } from 'vitest';
import { blockBounds, cityBounds, layoutCity, roomOnCity, STREET } from './city';

const block = (id: string, desks: number[]) => ({ id, rooms: desks.map((d, i) => ({ id: `${id}-r${i}`, desks: d })) });
const overlap = (a: { origin: { gx: number; gy: number }; width: number; height: number }, b: typeof a) =>
  a.origin.gx < b.origin.gx + b.width && b.origin.gx < a.origin.gx + a.width && a.origin.gy < b.origin.gy + b.height && b.origin.gy < a.origin.gy + a.height;

describe('layoutCity', () => {
  it('keeps the order given and separates blocks by a street', () => {
    const city = layoutCity([block('a', [2]), block('b', [2])], 60);
    expect(city.blocks.map((b) => b.id)).toEqual(['a', 'b']);
    expect(city.blocks[1].origin).toEqual({ gx: city.blocks[0].width + STREET, gy: 0 });
  });
  it('never overlaps blocks of very different sizes, and stays inside its own size', () => {
    const city = layoutCity([block('a', [1, 12, 0]), block('b', [40]), block('c', []), block('d', [3, 3, 3, 3, 3, 3]), block('e', [7])]);
    for (let i = 0; i < city.blocks.length; i++) for (let j = i + 1; j < city.blocks.length; j++) expect(overlap(city.blocks[i], city.blocks[j])).toBe(false);
    for (const b of city.blocks) {
      expect(b.origin.gx + b.width).toBeLessThanOrEqual(city.width);
      expect(b.origin.gy + b.height).toBeLessThanOrEqual(city.height);
    }
  });
  it('gives a machine with no projects a minimal block, so its sign has ground to stand on', () => {
    const city = layoutCity([block('empty', [])]);
    expect([city.blocks[0].width, city.blocks[0].height]).toEqual([5, 3]);
    expect(city.blocks[0].floor.rooms).toEqual([]);
  });
  it('is an empty, finite city for no machines', () => {
    const city = layoutCity([]);
    expect(city).toEqual({ blocks: [], width: 0, height: 0 });
    expect(Object.values(cityBounds(city, 28)).every(Number.isFinite)).toBe(true);
  });
  it('keeps an earlier block where it was when a later one grows', () => {
    const before = layoutCity([block('a', [3]), block('b', [3])], 80);
    const after = layoutCity([block('a', [3]), block('b', [30])], 80);
    expect(after.blocks[0].origin).toEqual(before.blocks[0].origin);
  });
});

describe('roomOnCity / bounds', () => {
  it('moves a room by its block origin and leaves the block-local layout alone', () => {
    const city = layoutCity([block('a', [2]), block('b', [2, 2])], 60);
    const b = city.blocks[1];
    const local = b.floor.rooms[1];
    const placed = roomOnCity(b, local);
    expect(placed.origin).toEqual({ gx: b.origin.gx + local.origin.gx, gy: b.origin.gy + local.origin.gy });
    expect(placed.layout).toBe(local.layout);
    expect(local.origin).toEqual(b.floor.rooms[1].origin); // not mutated
  });
  it('bounds of a later block sit to the right of an earlier one in the same row, and the city spans both', () => {
    const city = layoutCity([block('a', [2]), block('b', [2])], 60);
    const [a, b] = city.blocks.map((x) => blockBounds(x, 28));
    expect(b.x).toBeGreaterThan(a.x);
    const all = cityBounds(city, 28);
    expect(all.x).toBeLessThanOrEqual(a.x);
    expect(all.x + all.w).toBeGreaterThanOrEqual(b.x + b.w);
  });
});
