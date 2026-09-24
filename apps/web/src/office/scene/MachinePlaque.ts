/**
 * Freestanding machine nameplate: occupies a 1-terminal office bay; the art sits at that bay's centre.
 */
import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { SIGN_FOOTPRINT, type PlacedBlock } from '../layout/city';
import { depthOf, toScreen } from '../layout/iso';
import { ID } from './identity';
import { WALL_SKEW } from './wallPlaque';

/**
 * Digital screen centre in the PNG (frac from top-left). Label sits in world space over that
 * panel so it keeps size/skew readable (not crushed by sprite scale).
 */
const SIGN_SCREEN = { x: 0.5, y: 0.47 };
/** Max label width as a fraction of the on-screen sprite width. */
const SIGN_LABEL_MAX_W = 0.55;
/** Digital readout face — matches terminal/status chips, distinct from the sans office plaques. */
const SIGN_FONT = 'JetBrains Mono, Menlo, Monaco, monospace';

export type MachinePlaqueSize = {
  halfW: number;
  faceH: number;
  fontSize: number;
  /** target on-screen width of the sprite (px), when art is used */
  spriteW: number;
};

/** One size: fills the 1-terminal bay without depending on city scale. */
export function machinePlaqueSize(_offices = 0): MachinePlaqueSize {
  return { halfW: SIGN_FOOTPRINT.width / 2, faceH: 36, fontSize: 13, spriteW: 140 };
}

/** Art key — only `lg` ships; every machine uses it. */
export function machinePlaqueArtKey(_offices = 0): string | null {
  return 'machine-signin/lg';
}

/**
 * Centre of the 1-terminal bay, then one tile toward the office walls
 * (‑gx = left wall, ‑gy = back wall with plaque/lamp).
 */
export function machinePlaquePose(block: PlacedBlock): { gx: number; gy: number } {
  const { sign, origin } = block;
  return {
    gx: origin.gx + sign.origin.gx + sign.width / 2 - 1,
    gy: origin.gy + sign.origin.gy + sign.height / 2 - 1,
  };
}

type Local = (gx: number, gy: number, z: number) => { x: number; y: number };

function localOf(origin: { x: number; y: number }): Local {
  return (gx, gy, z) => {
    const p = toScreen(gx, gy, z);
    return { x: p.x - origin.x, y: p.y - origin.y };
  };
}

function quad(g: Graphics, loc: Local, pts: Array<[number, number, number]>, color: number, alpha = 1): void {
  const a = loc(...pts[0]!);
  const b = loc(...pts[1]!);
  const c = loc(...pts[2]!);
  const d = loc(...pts[3]!);
  g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]).fill({ color, alpha });
}

/** World-space nameplate centred in its 1-terminal office bay. */
export class MachinePlaque {
  readonly root = new Container();
  private readonly plate = new Graphics();
  private readonly sprite = new Sprite();
  private readonly label: Text;
  private art: Texture | null = null;

  constructor(block: PlacedBlock, model: { label: string; lit: boolean }, offices: number, art: Texture | null = null) {
    this.art = art;
    this.sprite.anchor.set(0.5, 0.5);
    this.sprite.visible = false;
    // Skew like the office wall plaques; mono face like the terminal readout.
    this.label = new Text({
      text: '',
      style: {
        fontSize: 13,
        fill: ID.fg,
        fontWeight: '600',
        fontFamily: SIGN_FONT,
        letterSpacing: 0.2,
      },
    });
    this.label.anchor.set(0.5);
    this.root.addChild(this.plate, this.sprite, this.label);
    this.root.eventMode = 'none';
    this.apply(block, model, offices, art);
  }

  apply(block: PlacedBlock, model: { label: string; lit: boolean }, offices: number, art: Texture | null = this.art): void {
    this.art = art;
    const pose = machinePlaquePose(block);
    const size = machinePlaqueSize(offices);
    const at = toScreen(pose.gx, pose.gy, 0);
    this.root.position.set(at.x, at.y);
    this.root.zIndex = depthOf(pose) + 0.3;
    const useArt = !!art && machinePlaqueArtKey(offices) !== null;
    if (useArt) this.paintSprite(size, model.lit);
    else this.paintProcedural(pose, size, model.lit);
    this.fitLabel(model.label, model.lit, size, useArt);
  }

  private paintSprite(size: MachinePlaqueSize, lit: boolean): void {
    this.plate.clear();
    this.plate.visible = false;
    this.sprite.visible = true;
    this.sprite.texture = this.art!;
    this.sprite.width = size.spriteW;
    this.sprite.height = size.spriteW;
    this.sprite.alpha = lit ? 1 : 0.55;
    this.sprite.tint = lit ? 0xffffff : 0x8890a0;
  }

  private paintProcedural(pose: { gx: number; gy: number }, size: MachinePlaqueSize, lit: boolean): void {
    this.sprite.visible = false;
    this.plate.visible = true;
    const loc = localOf(toScreen(pose.gx, pose.gy, 0));
    const { gx, gy } = pose;
    const { halfW, faceH } = size;
    const z0 = 4;
    this.plate.clear();
    this.drawStand(loc, gx, gy, halfW, faceH, z0, z0 + faceH, lit);
  }

  private drawStand(loc: Local, gx: number, gy: number, halfW: number, faceH: number, z0: number, z1: number, lit: boolean): void {
    const post = lit ? 0x3a4254 : 0x2a3140;
    const frame = lit ? ID.lineBright : ID.line;
    const face = lit ? 0x161920 : 0x12151c;
    quad(this.plate, loc, [
      [gx - halfW * 0.4, gy - 0.08, 0],
      [gx + halfW * 0.4, gy - 0.08, 0],
      [gx + halfW * 0.55, gy + 0.18, 0],
      [gx - halfW * 0.55, gy + 0.18, 0],
    ], 0x000000, lit ? 0.28 : 0.18);
    const postX = halfW * 0.72;
    for (const sx of [-postX, postX]) {
      quad(this.plate, loc, [
        [gx + sx - 0.06, gy, 0], [gx + sx + 0.06, gy, 0],
        [gx + sx + 0.06, gy, z0], [gx + sx - 0.06, gy, z0],
      ], post, 1);
    }
    quad(this.plate, loc, [
      [gx - halfW, gy, z0], [gx + halfW, gy, z0], [gx + halfW, gy, z1], [gx - halfW, gy, z1],
    ], frame, 1);
    const inset = halfW * 0.08;
    const zin = faceH * 0.12;
    quad(this.plate, loc, [
      [gx - halfW + inset, gy + 0.02, z0 + zin],
      [gx + halfW - inset, gy + 0.02, z0 + zin],
      [gx + halfW - inset, gy + 0.02, z1 - zin],
      [gx - halfW + inset, gy + 0.02, z1 - zin],
    ], face, 1);
  }

  private fitLabel(text: string, lit: boolean, size: MachinePlaqueSize, onSprite: boolean): void {
    this.label.text = text;
    this.label.style.fontFamily = SIGN_FONT;
    this.label.style.fontWeight = '600';
    this.label.style.fontSize = size.fontSize;
    this.label.style.fill = lit ? ID.fg : ID.dim;
    this.label.alpha = lit ? 1 : 0.55;
    this.label.rotation = 0;
    this.label.skew.set(0, WALL_SKEW);
    this.label.scale.set(1);
    this.label.anchor.set(0.5);
    this.label.pivot.set(0, 0);
    if (this.label.parent !== this.root) this.root.addChild(this.label);
    if (onSprite) {
      const sw = size.spriteW;
      this.label.position.set((SIGN_SCREEN.x - 0.5) * sw, (SIGN_SCREEN.y - 0.5) * sw);
      const maxW = sw * SIGN_LABEL_MAX_W;
      if (this.label.width > maxW) this.label.scale.set(maxW / this.label.width);
      return;
    }
    this.label.position.set(0, -(4 + size.faceH / 2));
    const maxW = size.halfW * 64 * 0.85;
    if (this.label.width > maxW) this.label.scale.set(maxW / this.label.width);
  }
}
