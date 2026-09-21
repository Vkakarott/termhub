/**
 * Everything that must stay readable: desk labels, markers, progress bars and room signs. These
 * live outside `world`, so furniture never covers them and they keep a fixed screen size;
 * `place()` puts each one back over its world point every frame.
 */
import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import type { DeskModel, Marker, RoomModel } from '../model';
import type { View } from './camera';

const MARKER: Record<Exclude<Marker, null>, { color: number; glyph: string }> = {
  input: { color: 0xd29922, glyph: '!' },
  permission: { color: 0xf0883e, glyph: '!' },
  error: { color: 0xf85149, glyph: '×' },
};

/**
 * Overlay text is read over furniture and people. It carries its own outline instead of a plate,
 * because anything opaque up here would hide the room behind it. `outline` is the colour it is
 * read against: the background for a label, the disc itself for a marker's glyph.
 */
const text = (size: number, fill: number, weight: '400' | '700' = '400', outline = 0x0f1115): TextStyleOptions => ({
  fontSize: size,
  fill,
  fontWeight: weight,
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  stroke: { color: outline, width: 3, join: 'round' },
});

/** Screen-space pieces of one desk. `world` is the desk's head point in world coordinates. */
export class DeskOverlay {
  readonly root = new Container();
  private readonly label: Text;
  private readonly marker = new Container();
  private readonly bar = new Graphics();
  private readonly barText: Text;
  private markerKind: Marker = null;
  private pulse = 0;
  hovered = false;

  constructor(
    readonly world: { x: number; y: number },
    model: DeskModel,
  ) {
    this.label = new Text({ text: model.label, style: text(11, 0xe6e8ee) });
    this.label.anchor.set(0.5, 0);
    this.barText = new Text({ text: '', style: text(10, 0xe6e8ee) });
    this.barText.anchor.set(0, 0.5);
    this.root.addChild(this.bar, this.barText, this.label, this.marker);
    this.apply(model);
  }

  apply(model: DeskModel): void {
    this.label.text = model.label;
    if (model.marker !== this.markerKind) {
      const entering = model.marker && model.marker !== 'error' && !this.markerKind;
      this.markerKind = model.marker;
      this.marker.removeChildren().forEach((c) => c.destroy());
      if (model.marker) {
        const m = MARKER[model.marker];
        const glyph = new Text({ text: m.glyph, style: text(14, 0x0f1115, '700', m.color) });
        glyph.anchor.set(0.5);
        this.marker.addChild(new Graphics().circle(0, 0, 10).fill(m.color).stroke({ color: 0x0f1115, width: 2 }), glyph);
      }
      if (entering) this.pulse = 1;
    }
    this.bar.clear();
    const p = model.progress;
    this.barText.text = p && p.total > 0 ? `${p.done}/${p.total}` : '';
    if (p && p.total > 0) {
      const done = p.done >= p.total;
      // the track needs its own outline: filled with a background colour it vanishes into the floor
      this.bar.roundRect(-20, -5, 40, 5, 2).fill(0x1e222b).stroke({ color: 0x4b5468, width: 1 });
      this.bar.roundRect(-20, -5, Math.max(2, 40 * (p.done / p.total)), 5, 2).fill(done ? 0x3fb950 : 0x4f8cff);
    }
  }

  /** `roomLevel`: labels and bars are for the room view; on the floor only the marker shows. */
  place(view: View, roomLevel: boolean, t: number, reducedMotion: boolean): void {
    const x = view.x + this.world.x * view.scale;
    const y = view.y + this.world.y * view.scale;
    this.root.position.set(Math.round(x), Math.round(y));
    const bounce = this.markerKind && this.markerKind !== 'error' && !reducedMotion ? Math.abs(Math.sin(t * 4)) * 6 : 0;
    this.pulse = Math.max(0, this.pulse - 0.03);
    this.marker.position.set(0, -16 - bounce);
    this.marker.scale.set(1 + this.pulse * 0.8);
    // the label clears the chair, which scales with the world; bar and count share one line right
    // under it, because stacked above the head they landed on the label of the desk behind
    const below = 39 * view.scale;
    this.label.visible = roomLevel || this.hovered;
    this.label.position.set(0, below);
    this.label.alpha = this.hovered ? 1 : 0.75;
    this.bar.visible = this.barText.visible = roomLevel;
    this.bar.position.set(-13, below + 21);
    this.barText.position.set(11, below + 18.5);
  }
}

/** The sign over a room's back corner: name, board progress, how many need you. */
export class RoomSign {
  readonly root = new Container();
  private readonly name: Text;
  private readonly detail: Text;

  constructor(
    readonly world: { x: number; y: number },
    model: RoomModel,
  ) {
    this.name = new Text({ text: model.label, style: text(13, 0xe6e8ee, '700') });
    this.detail = new Text({ text: '', style: text(11, 0x9aa1b1) });
    this.name.anchor.set(0.5, 1);
    this.detail.anchor.set(0.5, 0);
    this.root.addChild(this.name, this.detail);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.apply(model);
  }

  apply(model: RoomModel): void {
    this.name.text = model.label;
    const parts: string[] = [];
    if (model.progress) parts.push(`${model.progress.done}/${model.progress.total} tarefas`);
    if (model.needsYou > 0) parts.push(model.needsYou === 1 ? '1 precisa de você' : `${model.needsYou} precisam de você`);
    this.detail.text = parts.join(' · ');
    this.detail.style.fill = model.needsYou > 0 ? 0xf0883e : 0x9aa1b1;
    this.root.alpha = model.lit ? 1 : 0.6;
  }

  place(view: View): void {
    this.root.position.set(Math.round(view.x + this.world.x * view.scale), Math.round(view.y + this.world.y * view.scale));
  }
}
