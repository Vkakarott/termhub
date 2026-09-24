/** Where a building's desks sit on its one floor. Pure; the scene only draws the result. */
import { layoutRoom, type Cell, type RoomLayout } from './iso';

/**
 * A building's floor: every desk of the project in one open room — there is no room level any more
 * (city-by-project §3.2). The room layout's own rule decides the shape, so a building with no desk
 * still gets a small floor to stand its sign by.
 */
export type FloorLayout = RoomLayout;

export function layoutFloor(desks: number): FloorLayout {
  return layoutRoom(desks);
}

/** A floor on the city grid: its (0,0) tile and its layout. */
export interface PlacedFloor {
  origin: Cell;
  layout: FloorLayout;
}
