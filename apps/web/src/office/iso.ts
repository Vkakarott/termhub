/**
 * SPIKE (throwaway): isometric geometry and the generated room layout for the office world view.
 * Pure functions, no renderer — this is the part that would survive a renderer change.
 */

export const TILE_W = 64;
export const TILE_H = 32;

export interface Cell {
  gx: number;
  gy: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Grid → screen, 2:1 isometric. `(gx, gy)` may be fractional; `z` is height in pixels.
 * The point returned for an integer cell is the top vertex of that tile's diamond.
 */
export function toScreen(gx: number, gy: number, z = 0): Point {
  return { x: ((gx - gy) * TILE_W) / 2, y: ((gx + gy) * TILE_H) / 2 - z };
}

/** Painter's order: whatever is further down the screen is drawn later. */
export function depthOf(cell: Cell): number {
  return cell.gx + cell.gy;
}

export interface RoomLayout {
  /** room size in tiles */
  width: number;
  height: number;
  /** one cell per desk, in the order the desks were given */
  desks: Cell[];
}

/**
 * Lays out `count` desks in rows with a one-tile aisle around each, in a room a bit wider than
 * deep. The room grows with the count, so nothing here is hand-placed.
 */
export function layoutRoom(count: number): RoomLayout {
  const n = Math.max(1, count);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
  const rows = Math.ceil(n / cols);
  const desks: Cell[] = [];
  for (let i = 0; i < count; i++) {
    desks.push({ gx: 1 + (i % cols) * 2, gy: 1 + Math.floor(i / cols) * 2 });
  }
  return { width: cols * 2 + 1, height: rows * 2 + 1, desks };
}

/** Screen-space bounding box of a room's floor, walls included (`wallH` pixels above the floor). */
export function roomBounds(layout: RoomLayout, wallH: number): { x: number; y: number; w: number; h: number } {
  const left = toScreen(0, layout.height).x;
  const right = toScreen(layout.width, 0).x;
  const bottom = toScreen(layout.width, layout.height).y;
  return { x: left, y: -wallH, w: right - left, h: bottom + wallH };
}
