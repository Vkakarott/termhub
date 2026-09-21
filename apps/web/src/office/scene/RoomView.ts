/** The ground of one machine's block, and the floor and two back walls of one placed room. Colours only — no art needed. */
import { Graphics } from 'pixi.js';
import type { PlacedBlock } from '../layout/city';
import type { PlacedRoom } from '../layout/floor';
import { toScreen } from '../layout/iso';

/** Office partitions, not full walls: high enough to read as a room, low enough not to hide the one behind. */
export const WALL_H = 28;
const LIT = { a: 0x313847, b: 0x2b3140, wallL: 0x1e222b, wallR: 0x262b36 };
const DARK = { a: 0x1a1d25, b: 0x171a21, wallL: 0x13151b, wallR: 0x171a20 };
/** Tiles of bare ground around a block's rooms: the pavement that says where one machine ends. */
const BLOCK_MARGIN = 1;
const BLOCK = { lit: 0x1b1f28, dark: 0x13151b };

/**
 * One machine's ground: a flat diamond under everything that machine owns, a shade darker than a
 * room's floor. Also the machine's click target — it is what is left uncovered around its rooms.
 * Pass `into` to repaint it in place, like `drawRoom`.
 */
export function drawBlock(block: PlacedBlock, lit: boolean, into?: Graphics): Graphics {
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
  g.poly([n.x, n.y, e.x, e.y, s.x, s.y, w.x, w.y]).fill(lit ? BLOCK.lit : BLOCK.dark);
  g.eventMode = 'static';
  g.cursor = 'pointer';
  return g;
}

/**
 * Tiles and the two back walls; nothing in front, so people are never covered. Also the room's
 * click target. Pass `into` to repaint a room in place — a light going out keeps its handlers.
 */
export function drawRoom(room: PlacedRoom, lit: boolean, into?: Graphics): Graphics {
  const c = lit ? LIT : DARK;
  const { gx: ox, gy: oy } = room.origin;
  const { width, height } = room.layout;
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
