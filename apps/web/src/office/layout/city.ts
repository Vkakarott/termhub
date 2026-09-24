/** Where each building's block sits in the city. Pure; the scene only draws the result. */
import { layoutFloor, type FloorLayout, type PlacedFloor } from './floor';
import { toScreen, type Cell } from './iso';
import { packShelves } from './shelves';

/** Tiles between two blocks: wide enough that where a building ends reads by itself. */
export const STREET = 4;
/**
 * Tiles of bare ground around a block's floor: the pavement that says where one building ends. It
 * is part of the block — `drawBlock` paints it and `blockBounds` frames it — so it lives here, with
 * the geometry, rather than with the drawing: framed without it, both side vertices fell off the canvas.
 */
export const BLOCK_MARGIN = 1;
/** A building with no desk still gets ground for its sign. */
const MIN_BLOCK = { width: 5, height: 3 };

export interface BlockInput {
  id: string;
  /** how many desks the building's one floor holds */
  desks: number;
}

export interface PlacedBlock {
  id: string;
  /** the block's (0,0) tile on the city grid */
  origin: Cell;
  /** the building's floor, in block-local coordinates */
  floor: FloorLayout;
  width: number;
  height: number;
}

export interface CityLayout {
  blocks: PlacedBlock[];
  width: number;
  height: number;
}

export function layoutCity(blocks: BlockInput[], targetWidth?: number): CityLayout {
  const items = blocks.map((b) => {
    const floor = layoutFloor(b.desks);
    return { id: b.id, floor, width: Math.max(floor.width, MIN_BLOCK.width), height: Math.max(floor.height, MIN_BLOCK.height) };
  });
  const packed = packShelves(items, STREET, STREET, targetWidth);
  return { blocks: packed.placed.map(({ item, origin }) => ({ ...item, origin })), width: packed.width, height: packed.height };
}

/** A block's floor in city coordinates: it sits at the block's own origin. */
export function floorOnCity(block: PlacedBlock): PlacedFloor {
  return { origin: block.origin, layout: block.floor };
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

