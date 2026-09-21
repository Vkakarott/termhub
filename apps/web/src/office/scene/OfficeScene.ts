/** The office floor in PixiJS. Draws a FloorModel; knows nothing about tabs, the API or React. */
import { Application, Container, Rectangle, Texture, UPDATE_PRIORITY, type Graphics } from 'pixi.js';
import { floorBounds, layoutFloor, placedRoomBounds, type FloorLayout } from '../layout/floor';
import { depthOf, toScreen } from '../layout/iso';
import type { FloorModel } from '../model';
import { generatedPack } from '../pack/generated';
import type { PackManifest } from '../pack/manifest';
import { Camera } from './camera';
import { DeskOverlay, RoomSign } from './Overlay';
import { DeskView, type Textures } from './PersonView';
import { drawRoom, WALL_H } from './RoomView';

/**
 * Zoom from which a free-roaming view is close enough to be read as a room: a label keeps its
 * screen size, so below this the labels of two neighbouring desks (two tiles apart) run into
 * each other. Inside a focused room the labels are always on.
 */
const LABEL_SCALE = 1.8;

/** Room for the sign hanging over a room's back corner, so framing a room does not cut it off. */
const SIGN_H = 24;

export interface SceneHandlers {
  onPickDesk(deskId: string, projectId: string): void;
  onPickRoom(roomId: string): void;
  onPickSign(roomId: string): void;
  /** the person zoomed out far enough that "inside a room" no longer describes the view */
  onLeaveRoom(): void;
}

export class OfficeScene {
  private app: Application | null = null;
  private camera: Camera | null = null;
  private readonly world = new Container();
  private readonly floor = new Container();
  private readonly things = new Container();
  private readonly overlay = new Container();
  private textures: Textures = {};
  private manifest: PackManifest | null = null;
  private layout: FloorLayout = layoutFloor([]);
  private shape = '';
  private model: FloorModel | null = null;
  private desks = new Map<string, { view: DeskView; overlay: DeskOverlay }>();
  private signs = new Map<string, RoomSign>();
  private focused: string | null = null;
  private roomScale = 1;
  private destroyed = false;
  private readonly reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  frameMs = 0;

  constructor(private readonly handlers: SceneHandlers) {
    this.things.sortableChildren = true;
    // desk overlays over room signs: a sign must never hide a marker of the room in front of it
    this.overlay.sortableChildren = true;
    this.world.addChild(this.floor, this.things);
  }

  /** Async because Pixi v8 picks its renderer asynchronously; safe against an unmount in between. */
  async mount(host: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({ resizeTo: host, background: 0x0f1115, antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    if (this.destroyed) return app.destroy(true, { children: true });
    this.app = app;
    host.appendChild(app.canvas);
    const pack = generatedPack();
    this.manifest = pack.manifest;
    const source = Texture.from(pack.canvas).source;
    source.scaleMode = 'nearest';
    for (const [key, def] of Object.entries(pack.manifest.sprites)) {
      this.textures[key] = def.frames.map((f) => new Texture({ source, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    }
    app.stage.addChild(this.world, this.overlay);
    this.camera = new Camera(app.canvas);
    this.camera.onUserMove = () => {
      if (this.focused && this.camera && this.camera.target.scale < this.roomScale * 0.6) this.handlers.onLeaveRoom();
    };
    // brackets our update and Pixi's render (priority LOW) to get the CPU cost of one frame
    let t0 = 0;
    app.ticker.add(() => (t0 = performance.now()), undefined, UPDATE_PRIORITY.INTERACTION);
    app.ticker.add(() => this.tick());
    app.ticker.add(() => (this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1), undefined, UPDATE_PRIORITY.UTILITY);
    const onVisibility = () => (document.hidden ? app.ticker.stop() : app.ticker.start());
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanup = () => document.removeEventListener('visibilitychange', onVisibility);
    if (this.model) this.rebuild(this.model, true);
  }

  private cleanup: () => void = () => {};

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
    this.camera?.destroy();
    this.app?.destroy(true, { children: true });
    this.app = null;
  }

  get fps(): number {
    return this.app?.ticker.FPS ?? 0;
  }

  get rendererName(): string {
    return this.app?.renderer.name ?? '—';
  }

  /** Same rooms and desks (ids, kinds, order) → only properties change; otherwise the floor is rebuilt. */
  setModel(model: FloorModel): void {
    const shape = shapeOf(model);
    this.model = model;
    if (!this.app) return;
    if (shape !== this.shape) return this.rebuild(model, this.shape === '');
    for (const room of model.rooms) {
      this.signs.get(room.id)?.apply(room);
      for (const d of room.desks) {
        const desk = this.desks.get(d.id);
        desk?.view.apply(d);
        desk?.overlay.apply(d);
      }
    }
  }

  focusRoom(roomId: string | null, snap = false): void {
    this.focused = roomId;
    if (!this.camera) return;
    const placed = roomId ? this.layout.rooms.find((r) => r.id === roomId) : undefined;
    this.camera.frameBox(placed ? placedRoomBounds(placed, WALL_H + SIGN_H) : floorBounds(this.layout, WALL_H + SIGN_H), snap);
    if (placed) this.roomScale = this.camera.target.scale;
  }

  private rebuild(model: FloorModel, snap: boolean): void {
    if (!this.manifest) return;
    this.shape = shapeOf(model);
    this.layout = layoutFloor(model.rooms.map((r) => ({ id: r.id, desks: r.desks.length })));
    for (const layer of [this.floor, this.things, this.overlay]) layer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.desks.clear();
    this.signs.clear();
    model.rooms.forEach((room, i) => {
      const placed = this.layout.rooms[i];
      const ground: Graphics = drawRoom(placed, room.lit);
      ground.on('pointertap', () => this.clicked(() => this.handlers.onPickRoom(room.id)));
      this.floor.addChild(ground);
      const corner = toScreen(placed.origin.gx, placed.origin.gy);
      const sign = new RoomSign({ x: corner.x, y: corner.y - WALL_H - 6 }, room);
      sign.root.on('pointertap', () => this.clicked(() => this.handlers.onPickSign(room.id)));
      this.signs.set(room.id, sign);
      this.overlay.addChild(sign.root);
      room.desks.forEach((d, j) => {
        const cell = { gx: placed.origin.gx + placed.layout.desks[j].gx, gy: placed.origin.gy + placed.layout.desks[j].gy };
        const at = toScreen(cell.gx, cell.gy);
        const view = new DeskView(d, this.textures, this.manifest!, this.reducedMotion);
        view.root.position.set(at.x, at.y);
        view.root.zIndex = depthOf(cell);
        const overlay = new DeskOverlay({ x: at.x + view.head.x, y: at.y + view.head.y }, d);
        overlay.root.zIndex = 1;
        view.root.on('pointertap', () => this.clicked(() => this.handlers.onPickDesk(view.model.id, view.model.projectId)));
        view.root.on('pointerover', () => (overlay.hovered = true));
        view.root.on('pointerout', () => (overlay.hovered = false));
        this.things.addChild(view.root);
        this.overlay.addChild(overlay.root);
        this.desks.set(d.id, { view, overlay });
      });
    });
    const stillThere = this.focused && model.rooms.some((r) => r.id === this.focused);
    this.focusRoom(stillThere ? this.focused : null, snap);
  }

  /** A press that dragged the camera is not a click. */
  private clicked(fn: () => void): void {
    if ((this.camera?.dragged ?? 0) < 5) fn();
  }

  private tick(): void {
    if (!this.camera) return;
    const view = this.camera.tick();
    this.world.scale.set(view.scale);
    this.world.position.set(view.x, view.y);
    const t = performance.now() / 1000;
    const roomLevel = this.focused !== null || view.scale >= LABEL_SCALE;
    for (const { view: desk, overlay } of this.desks.values()) {
      desk.update();
      overlay.place(view, roomLevel, t, this.reducedMotion);
    }
    for (const sign of this.signs.values()) sign.place(view);
  }
}

/** What a rebuild depends on: the rooms and desks themselves, not their live state. */
function shapeOf(model: FloorModel): string {
  return model.rooms.map((r) => `${r.id}:${r.lit}[${r.desks.map((d) => `${d.id}:${d.kind}`).join(',')}]`).join('|');
}
