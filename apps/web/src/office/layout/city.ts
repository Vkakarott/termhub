/** Where each machine's floor sits in the city. Pure; the scene only draws the result. */
import { layoutFloor, placedRoomBounds, type FloorLayout, type PlacedRoom, type RoomInput } from './floor';
import { toScreen, type Cell } from './iso';
import { packShelves } from './shelves';

/** Tiles between two blocks: wider than a floor's corridor, so where a machine ends reads by itself. */
export const STREET = 4;
/**
 * Tiles of bare ground around a block's rooms: the pavement that says where one machine ends. It is
 * part of the block — `drawBlock` paints it and `blockBounds` frames it — so it lives here, with the
 * geometry, rather than with the drawing: framed without it, both side vertices fell off the canvas.
 */
export const BLOCK_MARGIN = 1;
/** A machine with no projects still gets ground for its sign. */
const MIN_BLOCK = { width: 5, height: 4 };
/**
 * Machine plaque bay = same tile footprint as a 1-terminal office (5×4).
 * The art sits at the centre of this bay; it is packed beside the real offices, not on top of them.
 */
export const SIGN_FOOTPRINT = { width: 5, height: 4 } as const;

export interface BlockInput {
  id: string;
  rooms: RoomInput[];
}

/** Reserved tile footprint for the freestanding machine nameplate — not shared with rooms. */
export interface SignSlot {
  /** block-local origin (NW corner of the footprint) */
  origin: Cell;
  width: number;
  height: number;
}

export interface PlacedBlock {
  id: string;
  /** the block's (0,0) tile on the city grid */
  origin: Cell;
  /** the machine's floor, in block-local coordinates */
  floor: FloorLayout;
  width: number;
  height: number;
  /** reserved tiles for the machine plaque; never overlaps a room */
  sign: SignSlot;
}

export interface CityLayout {
  blocks: PlacedBlock[];
  width: number;
  height: number;
}

function roomRects(floor: FloorLayout): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  return floor.rooms.map((r) => ({
    x0: r.origin.gx,
    y0: r.origin.gy,
    x1: r.origin.gx + r.layout.width,
    y1: r.origin.gy + r.layout.height,
  }));
}

function overlapsRoom(
  gx: number,
  gy: number,
  w: number,
  h: number,
  rooms: Array<{ x0: number; y0: number; x1: number; y1: number }>,
): boolean {
  const x1 = gx + w;
  const y1 = gy + h;
  return rooms.some((r) => gx < r.x1 && x1 > r.x0 && gy < r.y1 && y1 > r.y0);
}

/**
 * South edge of the offices (= front: opposite the back wall that holds the plaque and lamp).
 * Empty floor → 0 so the sign still has a front line to sit on.
 */
export function officeFrontGy(floor: FloorLayout): number {
  if (floor.rooms.length === 0) return 0;
  return Math.max(...floor.rooms.map((r) => r.origin.gy + r.layout.height));
}

/**
 * Free [x0, x1) along the office front line: columns that are not the south face of a room.
 * That is the lateral pavement beside the offices, on the same gy as their front.
 */
function frontFreeSpans(
  width: number,
  frontGy: number,
  rooms: Array<{ x0: number; y0: number; x1: number; y1: number }>,
): Array<{ x0: number; x1: number }> {
  const blocked = Array.from({ length: width }, () => false);
  for (const r of rooms) {
    if (r.y1 !== frontGy) continue;
    for (let x = Math.max(0, r.x0); x < Math.min(width, r.x1); x++) blocked[x] = true;
  }
  const spans: Array<{ x0: number; x1: number }> = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    const hit = x === width || blocked[x];
    if (!hit && start < 0) start = x;
    if (hit && start >= 0) {
      spans.push({ x0: start, x1: x });
      start = -1;
    }
  }
  return spans.sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
}

/**
 * Beside the offices on their front line (south edge of the sign = office front), centred in the
 * free lateral span. Grows the block east only when needed — never pushes the front south.
 */
export function allocateSign(floor: FloorLayout): { width: number; height: number; sign: SignSlot } {
  const { width: sw, height: sh } = SIGN_FOOTPRINT;
  const rooms = roomRects(floor);
  const frontGy = officeFrontGy(floor);
  // south edge of the sign on the office front → sign sits in the lateral gap, not past it
  const gy = Math.max(0, frontGy - sh);
  const fw = Math.max(floor.width, MIN_BLOCK.width, sw);
  const height = Math.max(floor.height, MIN_BLOCK.height, frontGy);

  for (const span of frontFreeSpans(fw, frontGy, rooms)) {
    if (span.x1 - span.x0 < sw) continue;
    const gx = centerInSpan(span.x0, span.x1, sw);
    if (overlapsRoom(gx, gy, sw, sh, rooms)) continue;
    return { width: fw, height, sign: { origin: { gx, gy }, width: sw, height: sh } };
  }

  // Front line fully taken: grow east only as much as the footprint needs (don't re-pack the city).
  const right = rooms.length ? Math.max(...rooms.map((r) => (r.y1 === frontGy ? r.x1 : 0))) : 0;
  const width = Math.max(fw, right + sw);
  const gx = centerInSpan(right, width, sw);
  return { width, height, sign: { origin: { gx, gy }, width: sw, height: sh } };
}

/** Integer centre of an [x0, x1) span for a run of `w` tiles. */
function centerInSpan(x0: number, x1: number, w: number): number {
  return Math.round((x0 + x1 - w) / 2);
}

export function layoutCity(blocks: BlockInput[], targetWidth?: number): CityLayout {
  const items = blocks.map((b) => {
    const floor = layoutFloor(b.rooms);
    const sized = allocateSign(floor);
    return { id: b.id, floor, width: sized.width, height: sized.height, sign: sized.sign };
  });
  const packed = packShelves(items, STREET, STREET, targetWidth);
  return { blocks: packed.placed.map(({ item, origin }) => ({ ...item, origin })), width: packed.width, height: packed.height };
}

/** A block-local room in city coordinates. */
export function roomOnCity(block: PlacedBlock, room: PlacedRoom): PlacedRoom {
  return { ...room, origin: { gx: block.origin.gx + room.origin.gx, gy: block.origin.gy + room.origin.gy } };
}

/** Screen-space box of a block's ground, pavement and `wallH` pixels of walls included. */
export function blockBounds(block: PlacedBlock, wallH: number): { x: number; y: number; w: number; h: number } {
  const gx = block.origin.gx - BLOCK_MARGIN;
  const gy = block.origin.gy - BLOCK_MARGIN;
  const width = block.width + BLOCK_MARGIN * 2;
  const height = block.height + BLOCK_MARGIN * 2;
  const left = toScreen(gx, gy + height).x;
  const right = toScreen(gx + width, gy).x;
  const top = toScreen(gx, gy).y - wallH;
  const bottom = toScreen(gx + width, gy + height).y;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Screen-space box of the whole city; a zero-size box at the origin when there are no blocks. */
export function cityBounds(city: CityLayout, wallH: number): { x: number; y: number; w: number; h: number } {
  if (city.blocks.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const boxes = city.blocks.map((b) => blockBounds(b, wallH));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

export { placedRoomBounds };
