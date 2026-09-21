import { describe, expect, it } from 'vitest';
import { floorBounds, layoutFloor, placedRoomBounds } from './floor';

const overlaps = (a: { origin: { gx: number; gy: number }; layout: { width: number; height: number } }, b: typeof a) =>
  a.origin.gx < b.origin.gx + b.layout.width && b.origin.gx < a.origin.gx + a.layout.width && a.origin.gy < b.origin.gy + b.layout.height && b.origin.gy < a.origin.gy + a.layout.height;

describe('layoutFloor', () => {
  it('places rooms in the order given, left to right, then on the next row', () => {
    const floor = layoutFloor([{ id: 'a', desks: 2 }, { id: 'b', desks: 2 }, { id: 'c', desks: 2 }], 12);
    expect(floor.rooms.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(floor.rooms[1].origin.gy).toBe(floor.rooms[0].origin.gy);
    expect(floor.rooms[1].origin.gx).toBe(floor.rooms[0].layout.width + 1);
    expect(floor.rooms[2].origin.gx).toBe(0);
    expect(floor.rooms[2].origin.gy).toBe(floor.rooms[0].layout.height + 2);
  });

  it('never overlaps rooms of very different sizes', () => {
    const floor = layoutFloor([1, 12, 0, 40, 3, 7, 0, 25].map((desks, i) => ({ id: `r${i}`, desks })));
    for (let i = 0; i < floor.rooms.length; i++) for (let j = i + 1; j < floor.rooms.length; j++) expect(overlaps(floor.rooms[i], floor.rooms[j])).toBe(false);
    for (const r of floor.rooms) {
      expect(r.origin.gx + r.layout.width).toBeLessThanOrEqual(floor.width);
      expect(r.origin.gy + r.layout.height).toBeLessThanOrEqual(floor.height);
    }
  });

  it('gives a room wider than the target its own row instead of looping', () => {
    const floor = layoutFloor([{ id: 'big', desks: 200 }, { id: 'small', desks: 1 }], 8);
    expect(floor.rooms[0].origin).toEqual({ gx: 0, gy: 0 });
    expect(floor.rooms[1].origin.gx).toBe(0);
  });

  it('is an empty, finite floor for no rooms', () => {
    const floor = layoutFloor([]);
    expect(floor).toEqual({ rooms: [], width: 0, height: 0 });
    const b = floorBounds(floor, 90);
    expect(Object.values(b).every(Number.isFinite)).toBe(true);
  });

  it('picks a target width that keeps the floor from being a single long row', () => {
    const floor = layoutFloor(Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, desks: 3 })));
    expect(new Set(floor.rooms.map((r) => r.origin.gy)).size).toBeGreaterThan(1);
  });

  it('keeps a room where it was when only a later room changes size', () => {
    const before = layoutFloor([{ id: 'a', desks: 3 }, { id: 'b', desks: 3 }, { id: 'c', desks: 3 }], 30);
    const after = layoutFloor([{ id: 'a', desks: 3 }, { id: 'b', desks: 3 }, { id: 'c', desks: 9 }], 30);
    expect(after.rooms[0].origin).toEqual(before.rooms[0].origin);
    expect(after.rooms[1].origin).toEqual(before.rooms[1].origin);
  });
});

describe('placedRoomBounds', () => {
  it('is the room box moved to its origin', () => {
    const floor = layoutFloor([{ id: 'a', desks: 1 }, { id: 'b', desks: 1 }], 40);
    const a = placedRoomBounds(floor.rooms[0], 90);
    const b = placedRoomBounds(floor.rooms[1], 90);
    expect(b.w).toBe(a.w);
    expect(b.x).toBeGreaterThan(a.x);
  });
});
