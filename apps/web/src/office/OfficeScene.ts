/**
 * SPIKE (throwaway): one isometric room rendered with PixiJS. Placeholder art is drawn with
 * Graphics so the spike needs no asset pack; a real version would swap `Person`/`drawDesk` for
 * spritesheet frames behind the same `setDesks` contract.
 */
import { Application, Container, Graphics, Text, UPDATE_PRIORITY } from 'pixi.js';
import type { TabState } from '../lib/types';
import { depthOf, layoutRoom, roomBounds, toScreen, type RoomLayout } from './layout/iso';

export interface DeskInput {
  id: string;
  name: string;
  /** null = the tab never reported a state: a person with no animation, not "idle" */
  state: TabState | null;
  kind: 'person' | 'phone';
}

const WALL_H = 90;
const SHIRT: Record<TabState, number> = {
  working: 0x3fb950,
  waiting_input: 0xd29922,
  waiting_permission: 0xf0883e,
  idle: 0x7d8799,
  error: 0xf85149,
};
const SKIN = 0xe8b998;

/** A box whose footprint is given in fractions of one tile, relative to the tile's top vertex. */
function isoBox(g: Graphics, u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, top: number, left: number, right: number): void {
  const p = (u: number, v: number, z: number) => {
    const s = toScreen(u, v, z);
    return [s.x, s.y];
  };
  g.poly([...p(u0, v1, z1), ...p(u1, v1, z1), ...p(u1, v1, z0), ...p(u0, v1, z0)]).fill(left);
  g.poly([...p(u1, v0, z1), ...p(u1, v1, z1), ...p(u1, v1, z0), ...p(u1, v0, z0)]).fill(right);
  g.poly([...p(u0, v0, z1), ...p(u1, v0, z1), ...p(u1, v1, z1), ...p(u0, v1, z1)]).fill(top);
}

class Desk {
  readonly root = new Container();
  private readonly screen = new Graphics();
  private readonly person = new Container();
  private readonly body = new Graphics();
  private readonly arm = new Graphics();
  private readonly head = new Graphics();
  private readonly bubble = new Container();
  private readonly zzz: Text;
  readonly label: Text;
  private readonly phase = Math.random() * 10;
  private state: TabState | null = null;
  hovered = false;

  constructor(
    readonly input: DeskInput,
    onPick: (id: string) => void,
  ) {
    const furniture = new Graphics();
    isoBox(furniture, 0.08, 0.92, 0.12, 0.5, 0, 14, 0x8a6a4a, 0x6b5138, 0x5a442f);
    this.root.addChild(furniture);

    if (input.kind === 'person') {
      isoBox(furniture, 0.36, 0.64, 0.2, 0.27, 14, 34, 0x2a2f3a, 0x1e222b, 0x161920);
      this.root.addChild(this.screen);
    } else {
      isoBox(furniture, 0.42, 0.58, 0.22, 0.42, 14, 17, 0x9ecbff, 0x1e222b, 0x161920);
    }

    const seat = toScreen(0.5, 0.8);
    this.person.position.set(seat.x, seat.y);
    this.person.addChild(this.body, this.arm, this.head);
    this.person.visible = input.kind === 'person';
    this.root.addChild(this.person);

    const mark = new Graphics().circle(0, 0, 9).fill(0xffffff).stroke({ color: 0x0f1115, width: 2 });
    const bang = new Text({ text: '!', style: { fontSize: 14, fontWeight: '700', fill: 0x0f1115, fontFamily: 'monospace' } });
    bang.anchor.set(0.5);
    this.bubble.addChild(mark, bang);
    this.bubble.position.set(seat.x, seat.y - 52);
    this.root.addChild(this.bubble);

    this.zzz = new Text({ text: 'z', style: { fontSize: 12, fontWeight: '700', fill: 0xcbd5e1, fontFamily: 'monospace' } });
    this.zzz.anchor.set(0.5);
    this.root.addChild(this.zzz);

    this.label = new Text({ text: input.name, style: { fontSize: 10, fill: 0xe6e8ee, fontFamily: 'monospace' } });
    this.label.anchor.set(0.5, 0);
    this.label.position.set(seat.x, seat.y + 6);
    this.root.addChild(this.label);

    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.root.on('pointertap', () => onPick(input.id));
    this.root.on('pointerover', () => (this.hovered = true));
    this.root.on('pointerout', () => (this.hovered = false));
    this.setState(input.state);
  }

  setState(state: TabState | null): void {
    this.state = state;
    const shirt = state ? SHIRT[state] : 0x475569;
    this.body.clear().roundRect(-8, -22, 16, 20, 5).fill(shirt);
    this.head.clear().circle(0, -29, 7).fill(state === 'error' ? 0xf85149 : SKIN);
    this.person.alpha = state ? 1 : 0.55;
    this.arm.clear();
    const waiting = state === 'waiting_input' || state === 'waiting_permission';
    if (waiting) this.arm.roundRect(6, -44, 5, 24, 2).fill(shirt).circle(8.5, -46, 3.5).fill(SKIN);
    this.bubble.visible = waiting;
    this.zzz.visible = state === 'idle';
    this.screen.clear();
  }

  /** `t` in seconds. Each state is a handful of property writes — no per-frame redraw except the screen glow. */
  update(t: number, scale: number): void {
    const p = t + this.phase;
    this.label.visible = this.hovered || scale >= 0.9;
    this.label.alpha = this.hovered ? 1 : 0.7;
    this.person.x = toScreen(0.5, 0.8).x;
    this.head.y = 0;
    this.head.rotation = 0;
    switch (this.state) {
      case 'working': {
        this.head.y = Math.sin(p * 9) * 0.8;
        const on = Math.sin(p * 13) > -0.3;
        this.screen.clear();
        const a = toScreen(0.38, 0.27, 32);
        const b = toScreen(0.62, 0.27, 32);
        this.screen.poly([a.x, a.y, b.x, b.y, b.x, b.y + 14, a.x, a.y + 14]).fill({ color: 0x4f8cff, alpha: on ? 0.95 : 0.55 });
        break;
      }
      case 'waiting_input':
      case 'waiting_permission':
        this.bubble.y = toScreen(0.5, 0.8).y - 52 - Math.abs(Math.sin(p * 4)) * 6;
        this.arm.rotation = Math.sin(p * 6) * 0.08;
        break;
      case 'idle': {
        this.head.y = 3;
        this.head.rotation = 0.25;
        const k = (p * 0.5) % 1;
        const seat = toScreen(0.5, 0.8);
        this.zzz.position.set(seat.x + 10 + k * 8, seat.y - 40 - k * 18);
        this.zzz.alpha = 1 - k;
        this.zzz.scale.set(0.7 + k * 0.6);
        break;
      }
      case 'error':
        this.person.x += Math.sin(p * 40) * 1.2;
        break;
      default:
        break;
    }
  }
}

export class OfficeScene {
  private app: Application | null = null;
  private readonly world = new Container();
  private readonly room = new Container();
  private readonly things = new Container();
  private desks = new Map<string, Desk>();
  private order = '';
  private layout: RoomLayout = layoutRoom(0);
  private target = { x: 0, y: 0, scale: 1 };
  private snap = true;
  private dragged = 0;
  private destroyed = false;
  /** smoothed CPU time of one frame (update + render submit), in ms */
  frameMs = 0;
  private cleanup: Array<() => void> = [];

  constructor(private readonly onPick: (id: string) => void) {
    this.things.sortableChildren = true;
    this.world.addChild(this.room, this.things);
  }

  /** Async because Pixi v8 picks its renderer asynchronously; safe against an unmount in between. */
  async mount(host: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({ resizeTo: host, background: 0x0f1115, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    if (this.destroyed) {
      app.destroy(true, { children: true });
      return;
    }
    this.app = app;
    host.appendChild(app.canvas);
    app.stage.addChild(this.world);
    this.bindCamera(app.canvas);
    // brackets our update + Pixi's render (priority LOW) to get the CPU cost of one frame
    let t0 = 0;
    app.ticker.add(() => (t0 = performance.now()), undefined, UPDATE_PRIORITY.INTERACTION);
    app.ticker.add(() => this.tick());
    app.ticker.add(() => (this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1), undefined, UPDATE_PRIORITY.UTILITY);
    this.fit();
  }

  destroy(): void {
    this.destroyed = true;
    this.cleanup.forEach((fn) => fn());
    this.app?.destroy(true, { children: true });
    this.app = null;
  }

  get fps(): number {
    return this.app?.ticker.FPS ?? 0;
  }

  get rendererName(): string {
    return this.app?.renderer.name ?? '—';
  }

  /** Same desks in the same order → only states change (no rebuild); otherwise the room is regenerated. */
  setDesks(inputs: DeskInput[]): void {
    const order = inputs.map((d) => `${d.id}:${d.kind}:${d.name}`).join('|');
    if (order === this.order) {
      for (const d of inputs) this.desks.get(d.id)?.setState(d.state);
      return;
    }
    this.order = order;
    this.layout = layoutRoom(inputs.length);
    this.things.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.desks = new Map();
    this.drawRoom();
    inputs.forEach((input, i) => {
      const cell = this.layout.desks[i];
      const desk = new Desk(input, (id) => {
        if (this.dragged < 5) this.onPick(id);
      });
      const at = toScreen(cell.gx, cell.gy);
      desk.root.position.set(at.x, at.y);
      desk.root.zIndex = depthOf(cell);
      this.things.addChild(desk.root);
      this.desks.set(input.id, desk);
    });
    this.fit();
  }

  /** Frames the whole room; the camera eases there unless this is the first frame. */
  fit(): void {
    if (!this.app) return;
    const b = roomBounds(this.layout, WALL_H);
    const { width, height } = this.app.screen;
    const scale = Math.min(2.5, Math.min(width / (b.w + 80), height / (b.h + 80)));
    this.target = { scale, x: width / 2 - (b.x + b.w / 2) * scale, y: height / 2 - (b.y + b.h / 2) * scale };
  }

  private drawRoom(): void {
    this.room.removeChildren().forEach((c) => c.destroy());
    const { width, height } = this.layout;
    const g = new Graphics();
    const o = toScreen(0, 0);
    const r = toScreen(width, 0);
    const l = toScreen(0, height);
    g.poly([o.x, o.y, r.x, r.y, r.x, r.y - WALL_H, o.x, o.y - WALL_H]).fill(0x262b36);
    g.poly([o.x, o.y, l.x, l.y, l.x, l.y - WALL_H, o.x, o.y - WALL_H]).fill(0x1e222b);
    for (let gx = 0; gx < width; gx++) {
      for (let gy = 0; gy < height; gy++) {
        const a = toScreen(gx, gy);
        const b = toScreen(gx + 1, gy);
        const c = toScreen(gx + 1, gy + 1);
        const d = toScreen(gx, gy + 1);
        g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]).fill((gx + gy) % 2 ? 0x313847 : 0x2b3140);
      }
    }
    this.room.addChild(g);
  }

  private bindCamera(canvas: HTMLCanvasElement): void {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const next = Math.min(4, Math.max(0.15, this.target.scale * Math.exp(-e.deltaY * 0.0015)));
      const k = next / this.target.scale;
      this.target = { scale: next, x: cx - (cx - this.target.x) * k, y: cy - (cy - this.target.y) * k };
    };
    let last: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      this.dragged = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      this.dragged += Math.abs(dx) + Math.abs(dy);
      this.target = { ...this.target, x: this.target.x + dx, y: this.target.y + dy };
      last = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => (last = null);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    this.cleanup.push(() => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    });
  }

  private tick(): void {
    const k = this.snap ? 1 : 0.18;
    this.snap = false;
    const w = this.world;
    w.scale.set(w.scale.x + (this.target.scale - w.scale.x) * k);
    w.position.set(w.x + (this.target.x - w.x) * k, w.y + (this.target.y - w.y) * k);
    const t = performance.now() / 1000;
    for (const desk of this.desks.values()) desk.update(t, w.scale.x);
  }
}
