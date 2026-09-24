/** The ground of one building's block, and the floor and two back walls of its one floor. Colours only — no art needed. */
import { Graphics } from 'pixi.js';
import { BLOCK_MARGIN, type PlacedBlock } from '../layout/city';
import type { PlacedFloor } from '../layout/floor';
import { toScreen } from '../layout/iso';

/** Office partitions, not full walls: high enough to read as a floor, low enough not to hide the block behind. */
export const WALL_H = 28;
const LIT = { a: 0x313847, b: 0x2b3140, wallL: 0x1e222b, wallR: 0x262b36 };
const DARK = { a: 0x1f2430, b: 0x1b202a, wallL: 0x14171f, wallR: 0x191d26 };
/**
 * A dark block still needs a silhouette. Filled alone, an unlit building's ground was four values per
 * channel away from the page background: its footprint, and the street around it, were simply not
 * there. So every block is outlined, which also tells two neighbouring blocks apart.
 */
const BLOCK = { lit: { fill: 0x242a36, line: 0x3f485c }, dark: { fill: 0x171b24, line: 0x2c3342 } };
/** In world units, so that at city zoom the outline lands on about one pixel. */
const BLOCK_LINE = 3;

/**
 * One building's ground: a flat diamond under its floor, a shade darker than the floor. Also the
 * building's click target — it is what is left uncovered around the floor. Pass `into` to repaint it
 * in place, like `drawFloor`.
 */
export function drawBlock(block: PlacedBlock, lit: boolean, into?: Graphics): Graphics {
  const c = lit ? BLOCK.lit : BLOCK.dark;
  const g = into ?? new Graphics();
  g.clear();
  const x0 = block.origin.gx - BLOCK_MARGIN;
  const y0 = block.origin.gy - BLOCK_MARGIN;
  const x1 = block.origin.gx + block.width + BLOCK_MARGIN;
  const y1 = block.origin.gy + block.height + BLOCK_MARGIN;
  const n = toScreen(x0, y0);
  const e = toScreen(x1, y0);
  const s = toScreen(x1, y1);
  const w = toScreen(x0, y1);
  g.poly([n.x, n.y, e.x, e.y, s.x, s.y, w.x, w.y])
    .fill(c.fill)
    .stroke({ color: c.line, width: BLOCK_LINE });
  g.eventMode = 'static';
  g.cursor = 'pointer';
  return g;
}

/**
 * Tiles and the two back walls of a building's floor; nothing in front, so people are never covered.
 * Also a click target for the building. Pass `into` to repaint it in place — a light going out keeps
 * its handlers.
 */
export function drawFloor(floor: PlacedFloor, lit: boolean, into?: Graphics): Graphics {
  const c = lit ? LIT : DARK;
  const { gx: ox, gy: oy } = floor.origin;
  const { width, height } = floor.layout;
  const g = into ?? new Graphics();
  g.clear();
  const o = toScreen(ox, oy);
  const r = toScreen(ox + width, oy);
  const l = toScreen(ox, oy + height);
  g.poly([o.x, o.y, r.x, r.y, r.x, r.y - WALL_H, o.x, o.y - WALL_H]).fill(c.wallR);
  g.poly([o.x, o.y, l.x, l.y, l.x, l.y - WALL_H, o.x, o.y - WALL_H]).fill(c.wallL);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const a = toScreen(ox + x, oy + y);
      const b = toScreen(ox + x + 1, oy + y);
      const d = toScreen(ox + x + 1, oy + y + 1);
      const e = toScreen(ox + x, oy + y + 1);
      g.poly([a.x, a.y, b.x, b.y, d.x, d.y, e.x, e.y]).fill((x + y) % 2 ? c.a : c.b);
    }
  }
  g.eventMode = 'static';
  g.cursor = 'pointer';
  return g;
}
