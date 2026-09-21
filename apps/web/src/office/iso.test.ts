import { describe, expect, it } from 'vitest';
import { depthOf, layoutRoom, roomBounds, toScreen } from './iso';

describe('toScreen', () => {
  it('projects the grid axes onto the two isometric diagonals', () => {
    expect(toScreen(0, 0)).toEqual({ x: 0, y: 0 });
    expect(toScreen(1, 0)).toEqual({ x: 32, y: 16 });
    expect(toScreen(0, 1)).toEqual({ x: -32, y: 16 });
    expect(toScreen(1, 1, 10)).toEqual({ x: 0, y: 22 });
  });
});

describe('layoutRoom', () => {
  it('gives every desk its own cell with an aisle between desks', () => {
    for (const count of [1, 2, 7, 40, 200]) {
      const { desks, width, height } = layoutRoom(count);
      expect(desks).toHaveLength(count);
      expect(new Set(desks.map((d) => `${d.gx},${d.gy}`)).size).toBe(count);
      for (const d of desks) {
        expect(d.gx % 2).toBe(1);
        expect(d.gy % 2).toBe(1);
        expect(d.gx).toBeLessThan(width - 1);
        expect(d.gy).toBeLessThan(height - 1);
      }
    }
  });

  it('still draws a room when there are no desks', () => {
    expect(layoutRoom(0)).toEqual({ width: 5, height: 3, desks: [] });
  });

  it('orders desks so that depth never decreases along a row', () => {
    const { desks } = layoutRoom(12);
    expect(depthOf(desks[1])).toBeGreaterThan(depthOf(desks[0]));
  });
});

describe('roomBounds', () => {
  it('spans the floor diamond plus the wall height', () => {
    const b = roomBounds({ width: 3, height: 3, desks: [] }, 80);
    expect(b).toEqual({ x: -96, y: -80, w: 192, h: 176 });
  });
});
