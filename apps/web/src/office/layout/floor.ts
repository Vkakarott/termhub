/** Where each room sits on a machine's floor. Pure; the scene only draws the result. */
import { layoutRoom, roomBounds, toScreen, type Cell, type RoomLayout } from './iso';

export interface RoomInput {
  id: string;
  desks: number;
}

export interface PlacedRoom {
  id: string;
  /** the room's (0,0) tile on the floor grid */
  origin: Cell;
  layout: RoomLayout;
}

export interface FloorLayout {
  rooms: PlacedRoom[];
  /** floor size in tiles */
  width: number;
  height: number;
}

const GAP_X = 1;
const CORRIDOR = 2;

/**
 * Shelf packing: rooms go left to right in the order given and wrap to a new row past
 * `targetWidth`. Order is never changed, so a room only moves when one before it changes size.
 * The default target makes the floor roughly square in tiles, which projects to about 2:1 on
 * screen — close to a monitor's shape once the walls are added.
 */
export function layoutFloor(rooms: RoomInput[], targetWidth?: number): FloorLayout {
  const layouts = rooms.map((r) => ({ id: r.id, layout: layoutRoom(r.desks) }));
  const area = layouts.reduce((sum, r) => sum + (r.layout.width + GAP_X) * (r.layout.height + CORRIDOR), 0);
  const widest = layouts.reduce((w, r) => Math.max(w, r.layout.width), 0);
  const target = Math.max(widest, targetWidth ?? Math.ceil(Math.sqrt(area) * 1.15));
  const placed: PlacedRoom[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const r of layouts) {
    if (x > 0 && x + r.layout.width > target) {
      x = 0;
      y += rowHeight + CORRIDOR;
      rowHeight = 0;
    }
    placed.push({ id: r.id, origin: { gx: x, gy: y }, layout: r.layout });
    width = Math.max(width, x + r.layout.width);
    x += r.layout.width + GAP_X;
    rowHeight = Math.max(rowHeight, r.layout.height);
  }
  return { rooms: placed, width, height: placed.length ? y + rowHeight : 0 };
}

/** Screen-space box of one placed room, walls included. */
export function placedRoomBounds(room: PlacedRoom, wallH: number): { x: number; y: number; w: number; h: number } {
  const b = roomBounds(room.layout, wallH);
  const o = toScreen(room.origin.gx, room.origin.gy);
  return { x: b.x + o.x, y: b.y + o.y, w: b.w, h: b.h };
}

/** Screen-space box of the whole floor; a zero-size box at the origin when there are no rooms. */
export function floorBounds(floor: FloorLayout, wallH: number): { x: number; y: number; w: number; h: number } {
  if (floor.rooms.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const boxes = floor.rooms.map((r) => placedRoomBounds(r, wallH));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}
