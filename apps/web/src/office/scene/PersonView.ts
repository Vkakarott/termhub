/** One desk: its furniture, the layered person on the chair, and the little animation clock. */
import { AnimatedSprite, Container, type Sprite, type Texture } from 'pixi.js';
import { toScreen } from '../layout/iso';
import type { DeskModel, Pose } from '../model';
import type { Anim, PackManifest } from '../pack/manifest';

export type Textures = Record<string, Texture[]>;

const SHIRT: Record<string, number> = { working: 0x3fb950, waiting_input: 0xd29922, waiting_permission: 0xf0883e, idle: 0x7d8799, error: 0xf85149, none: 0x475569 };
const SEAT = { u: 0.5, v: 0.78 };

function sprite(textures: Textures, manifest: PackManifest, key: string): AnimatedSprite {
  const def = manifest.sprites[key];
  const s = new AnimatedSprite(textures[key]);
  s.anchor.set(def.anchor.x / def.frames[0].w, def.anchor.y / def.frames[0].h);
  s.animationSpeed = def.fps / 60;
  if (def.fps > 0) s.play();
  return s;
}

export class DeskView {
  readonly root = new Container();
  /** world-space point of the person's head, relative to `root` */
  readonly head: { x: number; y: number };
  model: DeskModel;
  private readonly monitor: { on: Sprite; off: Sprite } | null = null;
  private readonly phone: { on: Sprite; off: Sprite } | null = null;
  private readonly person = new Container();
  private pose: Pose | null = null;
  private fade = 1;

  constructor(
    model: DeskModel,
    private readonly textures: Textures,
    private readonly manifest: PackManifest,
    private readonly reducedMotion: boolean,
  ) {
    this.model = model;
    this.root.addChild(sprite(textures, manifest, 'desk'));
    if (model.kind === 'phone') {
      this.phone = { on: sprite(textures, manifest, 'phone/on'), off: sprite(textures, manifest, 'phone/off') };
      this.root.addChild(this.phone.off, this.phone.on);
    } else {
      this.monitor = { on: sprite(textures, manifest, 'monitor/on'), off: sprite(textures, manifest, 'monitor/off') };
      this.root.addChild(this.monitor.off, this.monitor.on, sprite(textures, manifest, 'chair'));
    }
    const seat = toScreen(SEAT.u, SEAT.v);
    this.person.position.set(seat.x, seat.y);
    this.root.addChild(this.person);
    this.head = { x: seat.x + manifest.head.x, y: seat.y + manifest.head.y };
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.apply(model);
  }

  apply(model: DeskModel): void {
    this.model = model;
    if (this.monitor) this.monitor.on.visible = model.screenOn;
    if (this.phone) this.phone.on.visible = model.screenOn;
    if (model.pose === this.pose && this.person.children.length) {
      this.tintShirt();
      return;
    }
    this.pose = model.pose;
    this.person.removeChildren().forEach((c) => c.destroy());
    if (model.kind === 'phone' || model.pose === 'empty') return;
    const anim = model.pose as Anim;
    const body = sprite(this.textures, this.manifest, `person/${anim}/body`);
    const shirt = sprite(this.textures, this.manifest, `person/${anim}/shirt`);
    const hair = sprite(this.textures, this.manifest, 'person/hair');
    body.tint = this.manifest.skin[model.look];
    hair.tint = this.manifest.hair[model.look];
    if (this.reducedMotion) [body, shirt].forEach((s) => s.gotoAndStop(0));
    this.person.addChild(body, shirt, hair);
    this.fade = 0; // crossfade in (150 ms at 60 fps ≈ 9 frames); before the tint, or the new pose pops
    this.tintShirt();
  }

  private tintShirt(): void {
    const shirt = this.person.children[1] as Sprite | undefined;
    if (shirt) shirt.tint = SHIRT[this.model.state ?? 'none'];
    this.person.alpha = (this.model.dimmed ? 0.55 : 1) * this.fade;
  }

  update(): void {
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + 1 / 9);
      this.person.alpha = (this.model.dimmed ? 0.55 : 1) * this.fade;
    }
  }
}
