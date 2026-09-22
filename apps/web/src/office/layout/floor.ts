/** Where each room sits on a machine's floor. Pure; the scene only draws the result. */
import { layoutRoom, roomBounds, toScreen, type Cell, type RoomLayout } from './iso';
import { packShelves } from './shelves';

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

/** Packs each room's layout with the shared shelf packer; see shelves.ts for how packing works. */
export function layoutFloor(rooms: RoomInput[], targetWidth?: number): FloorLayout {
  const items = rooms.map((r) => {
    const layout = layoutRoom(r.desks);
    return { id: r.id, layout, width: layout.width, height: layout.height };
  });
  const packed = packShelves(items, GAP_X, CORRIDOR, targetWidth);
  return { rooms: packed.placed.map(({ item, origin }) => ({ id: item.id, origin, layout: item.layout })), width: packed.width, height: packed.height };
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
