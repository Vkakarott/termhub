/**
 * The in-house pack: pixel art painted by code onto one canvas, described by a manifest like any
 * other pack. Everything is drawn in whole pixels and meant to be sampled with 'nearest'.
 */
import { TILE_H, TILE_W } from '../layout/iso';
import { ANIMS, validateManifest, type Anim, type FrameRect, type PackManifest, type SpriteDef } from './manifest';

const OUTLINE = '#0f1115';
const CELL = { w: 32, h: 48 };
type Ctx = CanvasRenderingContext2D;

/** A filled pixel rectangle with a 1px outline around it. */
function block(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string): void {
  ctx.fillStyle = OUTLINE;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
}

/** An isometric box drawn as pixel columns, footprint in tile fractions, heights in px. Origin = tile top vertex. */
function isoBox(ctx: Ctx, ox: number, oy: number, u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, top: string, left: string, right: string): void {
  const p = (u: number, v: number, z: number): [number, number] => [Math.round(ox + ((u - v) * TILE_W) / 2), Math.round(oy + ((u + v) * TILE_H) / 2 - z)];
  const face = (pts: Array<[number, number]>, fill: string) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  face([p(u0, v1, z1), p(u1, v1, z1), p(u1, v1, z0), p(u0, v1, z0)], left);
  face([p(u1, v0, z1), p(u1, v1, z1), p(u1, v1, z0), p(u1, v0, z0)], right);
  face([p(u0, v0, z1), p(u1, v0, z1), p(u1, v1, z1), p(u0, v1, z1)], top);
}

/** One person frame, feet at the cell's bottom centre. `layer` picks which tintable part is painted (in white). */
function person(ctx: Ctx, cx: number, by: number, anim: Anim, frame: number, layer: 'body' | 'shirt' | 'hair'): void {
  const bob = anim === 'type' ? frame % 2 : anim === 'sleep' ? 3 : 0;
  const lean = anim === 'sleep' ? 2 : 0;
  const shake = anim === 'shake' ? (frame % 2 ? 1 : -1) : 0;
  const x = cx + shake;
  const W = '#ffffff';
  if (layer === 'shirt') {
    block(ctx, x - 6, by - 22, 12, 14, W);
    if (anim === 'raise') block(ctx, x + 6, by - 36 - (frame % 2), 3, 16, W);
    if (anim === 'type') block(ctx, x - 8 + (frame % 2) * 2, by - 14, 3, 5, W);
  } else if (layer === 'body') {
    block(ctx, x - 5 + lean, by - 33 + bob, 10, 10, W);
    if (anim === 'raise') block(ctx, x + 6, by - 40 - (frame % 2), 3, 4, W);
    block(ctx, x - 5, by - 8, 4, 8, '#3a4152');
    block(ctx, x + 1, by - 8, 4, 8, '#3a4152');
  } else {
    block(ctx, x - 5 + lean, by - 35 + bob, 10, 4, W);
  }
}

export function generatedPack(): { manifest: PackManifest; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const sprites: Record<string, SpriteDef> = {};
  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;
  /** Reserves a w×h cell in the atlas and returns its rect. */
  const alloc = (w: number, h: number): FrameRect => {
    if (cursorX + w > canvas.width) {
      cursorX = 0;
      cursorY += rowH;
      rowH = 0;
    }
    const r = { x: cursorX, y: cursorY, w, h };
    cursorX += w;
    rowH = Math.max(rowH, h);
    return r;
  };

  // furniture: one 72×64 cell each, the tile's top vertex at (36, 24) inside the cell
  const furniture = (key: string, paint: (ox: number, oy: number) => void) => {
    const r = alloc(72, 64);
    paint(r.x + 36, r.y + 24);
    sprites[key] = { frames: [r], anchor: { x: 36, y: 24 }, fps: 0 };
  };
  furniture('desk', (ox, oy) => isoBox(ctx, ox, oy, 0.08, 0.92, 0.12, 0.5, 0, 14, '#8a6a4a', '#6b5138', '#5a442f'));
  furniture('chair', (ox, oy) => isoBox(ctx, ox, oy, 0.36, 0.64, 0.62, 0.9, 0, 9, '#4b5468', '#3a4152', '#2f3544'));
  furniture('monitor/off', (ox, oy) => isoBox(ctx, ox, oy, 0.36, 0.64, 0.2, 0.27, 14, 34, '#2a2f3a', '#1e222b', '#161920'));
  furniture('monitor/on', (ox, oy) => isoBox(ctx, ox, oy, 0.36, 0.64, 0.2, 0.27, 14, 34, '#2a2f3a', '#4f8cff', '#161920'));
  furniture('phone/off', (ox, oy) => isoBox(ctx, ox, oy, 0.42, 0.58, 0.22, 0.42, 14, 17, '#1e222b', '#1e222b', '#161920'));
  furniture('phone/on', (ox, oy) => isoBox(ctx, ox, oy, 0.42, 0.58, 0.22, 0.42, 14, 17, '#9ecbff', '#1e222b', '#161920'));

  // people: 2 frames per animation (1 for sit and sleep), body and shirt layers
  const FRAMES: Record<Anim, number> = { sit: 1, type: 2, raise: 2, sleep: 1, shake: 2 };
  const FPS: Record<Anim, number> = { sit: 0, type: 6, raise: 3, sleep: 0, shake: 12 };
  for (const anim of ANIMS) {
    for (const layer of ['body', 'shirt'] as const) {
      const frames: FrameRect[] = [];
      for (let f = 0; f < FRAMES[anim]; f++) {
        const r = alloc(CELL.w, CELL.h);
        person(ctx, r.x + CELL.w / 2, r.y + CELL.h - 2, anim, f, layer);
        frames.push(r);
      }
      sprites[`person/${anim}/${layer}`] = { frames, anchor: { x: CELL.w / 2, y: CELL.h - 2 }, fps: FPS[anim] };
    }
  }
  const hair = alloc(CELL.w, CELL.h);
  person(ctx, hair.x + CELL.w / 2, hair.y + CELL.h - 2, 'sit', 0, 'hair');
  sprites['person/hair'] = { frames: [hair], anchor: { x: CELL.w / 2, y: CELL.h - 2 }, fps: 0 };

  const manifest: PackManifest = {
    name: 'generated',
    tile: { w: TILE_W, h: TILE_H },
    sprites,
    head: { x: 0, y: -36 },
    skin: [0xf2c9a5, 0xe8b998, 0xc99674, 0xa5714f, 0x7d4f34, 0x5a3825],
    hair: [0x2b1d14, 0x4a3323, 0x8a5a2b, 0xd9b36a, 0x9a9a9a, 0x1b1b1b],
  };
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`generated pack is invalid: ${problems.join('; ')}`);
  return { manifest, canvas };
}
