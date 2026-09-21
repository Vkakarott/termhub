/**
 * The sprite contract: what any art pack must provide. The scene knows this file and nothing
 * about how a pack was made, so art is replaced by swapping the pack.
 */
import { LOOK_VARIANTS } from '../model';

export const ANIMS = ['sit', 'type', 'raise', 'sleep', 'shake'] as const;
export type Anim = (typeof ANIMS)[number];

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpriteDef {
  frames: FrameRect[];
  /** the pixel of the frame that sits on the tile point the sprite is placed at */
  anchor: { x: number; y: number };
  /** 0 for a still sprite */
  fps: number;
}

export interface PackManifest {
  name: string;
  tile: { w: number; h: number };
  sprites: Record<string, SpriteDef>;
  /** from a person's anchor to the top of the head: where markers go and what is clicked */
  head: { x: number; y: number };
  skin: number[];
  hair: number[];
}

export const REQUIRED_SPRITES: string[] = [
  'chair',
  'desk',
  'monitor/off',
  'monitor/on',
  'person/hair',
  'phone/off',
  'phone/on',
  ...ANIMS.flatMap((a) => [`person/${a}/body`, `person/${a}/shirt`]),
].sort();

export function validateManifest(m: PackManifest): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED_SPRITES) if (!m.sprites[key]) problems.push(`missing sprite: ${key}`);
  for (const [key, s] of Object.entries(m.sprites).sort(([a], [b]) => a.localeCompare(b))) {
    if (s.frames.length === 0) problems.push(`sprite ${key} has no frames`);
    else if (s.frames.length > 1 && s.fps <= 0) problems.push(`sprite ${key} has ${s.frames.length} frames but no fps`);
  }
  for (const list of ['skin', 'hair'] as const) if (m[list].length < LOOK_VARIANTS) problems.push(`${list} needs ${LOOK_VARIANTS} tints, has ${m[list].length}`);
  return problems;
}
