import { describe, expect, it } from 'vitest';
import { allocateSign, BLOCK_MARGIN, blockBounds, cityBounds, layoutCity, roomOnCity, STREET } from './city';
import { layoutFloor } from './floor';

const block = (id: string, desks: number[]) => ({ id, rooms: desks.map((d, i) => ({ id: `${id}-r${i}`, desks: d })) });
const overlap = (a: { origin: { gx: number; gy: number }; width: number; height: number }, b: typeof a) =>
  a.origin.gx < b.origin.gx + b.width && b.origin.gx < a.origin.gx + a.width && a.origin.gy < b.origin.gy + b.height && b.origin.gy < a.origin.gy + a.height;

const signHitsRoom = (b: {
  floor: { rooms: Array<{ origin: { gx: number; gy: number }; layout: { width: number; height: number } }> };
  sign: { origin: { gx: number; gy: number }; width: number; height: number };
}) =>
  b.floor.rooms.some((r) => {
    const s = b.sign;
    return (
      s.origin.gx < r.origin.gx + r.layout.width &&
      r.origin.gx < s.origin.gx + s.width &&
      s.origin.gy < r.origin.gy + r.layout.height &&
      r.origin.gy < s.origin.gy + s.height
    );
  });

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
    expect([city.blocks[0].width, city.blocks[0].height]).toEqual([5, 4]);
    expect(city.blocks[0].floor.rooms).toEqual([]);
    expect(city.blocks[0].sign.width).toBeGreaterThan(0);
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
  it('reserves a sign footprint that never overlaps a room', () => {
    const city = layoutCity([block('a', [2]), block('b', [2, 2, 2]), block('c', [12, 3, 3, 3, 40])]);
    for (const b of city.blocks) {
      expect(signHitsRoom(b)).toBe(false);
      expect(b.sign.origin.gx + b.sign.width).toBeLessThanOrEqual(b.width);
      expect(b.sign.origin.gy + b.sign.height).toBeLessThanOrEqual(b.height);
    }
  });
});

describe('allocateSign', () => {
  it('aligns a 1-terminal bay with the office front, centred in the lateral gap', () => {
    const floor = layoutFloor([
      { id: 'r1', desks: 2 },
      { id: 'r2', desks: 2 },
      { id: 'r3', desks: 2 },
    ]);
    const front = Math.max(...floor.rooms.map((r) => r.origin.gy + r.layout.height));
    const frontRoom = floor.rooms.find((r) => r.origin.gy + r.layout.height === front)!;
    const sized = allocateSign(floor);
    expect(sized.sign.width).toBe(5);
    expect(sized.sign.height).toBe(4);
    expect(sized.sign.origin.gy + sized.sign.height).toBe(front);
    expect(sized.height).toBe(floor.height);
    const free0 = frontRoom.origin.gx + frontRoom.layout.width;
    const free1 = sized.width;
    const mid = (free0 + free1) / 2;
    expect(Math.abs(sized.sign.origin.gx + sized.sign.width / 2 - mid)).toBeLessThanOrEqual(0.5);
    expect(sized.sign.origin.gx).toBeGreaterThanOrEqual(free0);
  });
  it('grows east (not south) when a single room fills the front line', () => {
    const floor = layoutFloor([{ id: 'r', desks: 2 }]);
    const front = floor.rooms[0]!.origin.gy + floor.rooms[0]!.layout.height;
    const sized = allocateSign(floor);
    expect(sized.sign.origin.gy + sized.sign.height).toBe(front);
    expect(sized.height).toBe(floor.height);
    expect(sized.width).toBeGreaterThan(floor.width);
    expect(sized.sign.origin.gx).toBeGreaterThanOrEqual(floor.rooms[0]!.layout.width);
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
    expect(local.origin).toEqual(b.floor.rooms[1].origin);
  });
  it('frames the pavement the block is drawn with, including the sign strip', () => {
    const city = layoutCity([block('a', [2])]);
    const b = city.blocks[0];
    expect(b.origin).toEqual({ gx: 0, gy: 0 });
    expect(b.width).toBeGreaterThanOrEqual(b.floor.width);
    expect(b.height).toBeGreaterThanOrEqual(b.floor.height);
    expect(BLOCK_MARGIN).toBe(1);
    const box = blockBounds(b, 28);
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
    expect(cityBounds(city, 28)).toEqual(box);
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
