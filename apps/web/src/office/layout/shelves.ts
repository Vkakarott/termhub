/** Shelf packing for the blocks of the city. Pure. */
import type { Cell } from './iso';

export interface Sized {
  width: number;
  height: number;
}

/**
 * Items go left to right in the order given and wrap to a new row past `targetWidth`. Order is
 * never changed, so an item only moves when one before it changes size. The target is never
 * narrower than the widest item, so a row always takes at least one item and the loop cannot
 * stall. The default target makes the packing roughly square in tiles, which projects to about
 * 2:1 on screen.
 */
export function packShelves<T extends Sized>(items: T[], gapX: number, gapY: number, targetWidth?: number): { placed: Array<{ item: T; origin: Cell }>; width: number; height: number } {
  const area = items.reduce((sum, i) => sum + (i.width + gapX) * (i.height + gapY), 0);
  const widest = items.reduce((w, i) => Math.max(w, i.width), 0);
  const target = Math.max(widest, targetWidth ?? Math.ceil(Math.sqrt(area) * 1.15));
  const placed: Array<{ item: T; origin: Cell }> = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const item of items) {
    if (x > 0 && x + item.width > target) {
      x = 0;
      y += rowHeight + gapY;
      rowHeight = 0;
    }
    placed.push({ item, origin: { gx: x, gy: y } });
    width = Math.max(width, x + item.width);
    x += item.width + gapX;
    rowHeight = Math.max(rowHeight, item.height);
  }
  return { placed, width, height: placed.length ? y + rowHeight : 0 };
}
