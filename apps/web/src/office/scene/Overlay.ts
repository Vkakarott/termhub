/**
 * Everything that must stay readable: desk labels, markers, progress bars and room signs. These
 * live outside `world`, so furniture never covers them and they keep a fixed screen size;
 * `place()` puts each one back over its world point every frame.
 */
import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import { truncateLabel, type DeskModel, type MachineModel, type MachineNotice, type Marker, type RoomModel } from '../model';
import type { View } from './camera';

/** Hover is where a name cut to 18 characters and a task title become readable: room for both. */
const HOVER_MAX = 48;

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
  /** the bound task's title, hover only: a task without subtasks has no bar, so this is all it gets */
  private readonly title: Text;
  private readonly marker = new Container();
  private readonly bar = new Graphics();
  private readonly barText: Text;
  private markerKind: Marker = null;
  private short = '';
  private full = '';
  private pulse = 0;
  hovered = false;

  constructor(
    readonly world: { x: number; y: number },
    model: DeskModel,
  ) {
    this.label = new Text({ text: model.label, style: text(11, 0xe6e8ee) });
    this.label.anchor.set(0.5, 0);
    this.title = new Text({ text: '', style: text(10, 0x9aa1b1) });
    this.title.anchor.set(0.5, 0);
    this.barText = new Text({ text: '', style: text(10, 0xe6e8ee) });
    this.barText.anchor.set(0, 0.5);
    this.root.addChild(this.bar, this.barText, this.label, this.title, this.marker);
    this.apply(model);
  }

  apply(model: DeskModel): void {
    this.short = model.label;
    this.full = truncateLabel(model.name, HOVER_MAX);
    this.title.text = model.progress ? truncateLabel(model.progress.title, HOVER_MAX) : '';
    this.label.text = this.hovered ? this.full : this.short;
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
    // hovering is the only place the whole name and the task's title are readable, so it takes the
    // full name over the cut label, adds the title on a second line and pushes the bar down under it
    this.label.visible = roomLevel || this.hovered;
    this.label.text = this.hovered ? this.full : this.short;
    this.label.position.set(0, below);
    this.label.alpha = this.hovered ? 1 : 0.75;
    const titled = this.hovered && this.title.text !== '';
    this.title.visible = titled;
    this.title.position.set(0, below + 14);
    const barY = below + (titled ? 35 : 21);
    this.bar.visible = this.barText.visible = roomLevel;
    this.bar.position.set(-13, barY);
    this.barText.position.set(11, barY - 2.5);
    // over every other overlay item (its neighbours' labels, the room signs), or it reads as clipped
    const z = this.hovered ? 2 : 1;
    if (this.root.zIndex !== z) this.root.zIndex = z;
  }
}

const needsYouText = (n: number) => (n === 1 ? '1 precisa de você' : `${n} precisam de você`);

/**
 * A sign hanging over a world point: a bold name, a muted detail line under it, no plate.
 * `lift` is extra height in SCREEN pixels. The world anchor shrinks with the zoom while markers,
 * labels and the signs themselves keep their screen size, so a sign that clears what is under it
 * at close range lands right on top of it once the camera pulls back.
 */
class Sign {
  readonly root = new Container();
  private readonly name: Text;
  private readonly detail: Text;

  constructor(
    readonly world: { x: number; y: number },
    size: number,
    private readonly lift = 0,
  ) {
    this.name = new Text({ text: '', style: text(size, 0xe6e8ee, '700') });
    this.detail = new Text({ text: '', style: text(11, 0x9aa1b1) });
    this.name.anchor.set(0.5, 1);
    this.detail.anchor.set(0.5, 0);
    this.root.addChild(this.name, this.detail);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
  }

  /** `attention`: something in there is waiting for the person, so the detail line is orange. */
  protected write(label: string, parts: string[], attention: boolean, lit: boolean): void {
    this.name.text = label;
    this.detail.text = parts.join(' · ');
    this.detail.style.fill = attention ? 0xf0883e : 0x9aa1b1;
    this.root.alpha = lit ? 1 : 0.6;
  }

  place(view: View): void {
    this.root.position.set(Math.round(view.x + this.world.x * view.scale), Math.round(view.y + this.world.y * view.scale - this.lift));
  }
}

/** The sign over a room's back corner: name, board progress, how many need you. */
export class RoomSign extends Sign {
  constructor(world: { x: number; y: number }, model: RoomModel) {
    super(world, 13);
    this.apply(model);
  }

  apply(model: RoomModel): void {
    const parts: string[] = [];
    if (model.progress) parts.push(`${model.progress.done}/${model.progress.total} tarefas`);
    if (model.needsYou > 0) parts.push(needsYouText(model.needsYou));
    this.write(model.label, parts, model.needsYou > 0, model.lit);
  }
}

/** Why a machine's block may not be telling the truth, read from across the city. */
const NOTICE: Record<Exclude<MachineNotice, null>, string> = {
  offline: 'offline',
  silent: 'sem resposta',
  error: 'não foi possível carregar',
};

/**
 * The block's first room starts at the block's own back corner, so at city zoom this sign would sit
 * on that room's sign and on the raised hands of its first row of desks. This clears both.
 */
const MACHINE_LIFT = 36;

/** The sign over a block's back corner: the machine's name, its notice and how many need you. */
export class MachineSign extends Sign {
  constructor(world: { x: number; y: number }, model: MachineModel) {
    super(world, 16, MACHINE_LIFT);
    this.apply(model);
  }

  apply(model: MachineModel): void {
    const parts: string[] = [];
    if (model.notice) parts.push(NOTICE[model.notice]);
    if (model.needsYou > 0) parts.push(needsYouText(model.needsYou));
    this.write(model.label, parts, model.needsYou > 0, model.lit);
  }
}
