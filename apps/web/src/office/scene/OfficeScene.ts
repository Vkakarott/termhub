/** The city in PixiJS: one block per machine, rooms and desks inside. Knows nothing about tabs, the API or React. */
import { Application, CanvasSource, Container, Rectangle, Texture, UPDATE_PRIORITY, type Graphics } from 'pixi.js';
import { blockBounds, cityBounds, layoutCity, placedRoomBounds, roomOnCity, type CityLayout, type PlacedBlock } from '../layout/city';
import type { PlacedRoom } from '../layout/floor';
import { depthOf, toScreen } from '../layout/iso';
import { sameFocus, type CityModel, type FocusTarget } from '../model';
import { generatedPack } from '../pack/generated';
import type { PackManifest } from '../pack/manifest';
import { Camera, type Box } from './camera';
import { signVisibility } from './detail';
import { DeskOverlay, MachineSign, RoomSign } from './Overlay';
import { DeskView, type Textures } from './PersonView';
import { BLOCK_MARGIN, drawBlock, drawRoom, WALL_H } from './RoomView';

/**
 * Zoom from which a free-roaming view is close enough to be read as a room: a label keeps its
 * screen size, so below this the labels of two neighbouring desks (two tiles apart) run into
 * each other. Inside a focused room the labels of that room are always on.
 */
const LABEL_SCALE = 1.8;

/** Room for the sign hanging over a room's back corner, so framing a room does not cut it off. */
const SIGN_H = 24;

/** Headroom a block (or the whole city) needs above its ground, for walls and room signs. */
const BLOCK_TOP = WALL_H + SIGN_H;

/** And under it, for the machine sign that hangs over the block's front corner. */
const BLOCK_BOTTOM = SIGN_H + 32;

/** What is left of an unlit machine's furniture and people. Its markers keep their full strength. */
const UNLIT_ALPHA = 0.45;

/** One room as drawn, so a light going out can repaint it where it stands. */
interface DrawnRoom {
  ground: Graphics;
  placed: PlacedRoom;
  lit: boolean;
}

/** One machine as drawn. `rooms` and `signs` are in model order, which the shape check pins. */
interface DrawnMachine {
  block: PlacedBlock;
  ground: Graphics;
  lit: boolean;
  sign: MachineSign;
  rooms: DrawnRoom[];
  signs: RoomSign[];
  /** every desk of this machine, so its light going out dims them all without a rebuild */
  views: DeskView[];
}

export interface SceneHandlers {
  onPickDesk(deskId: string, projectId: string): void;
  onPickRoom(machineId: string, roomId: string): void;
  onPickMachine(machineId: string): void;
  onPickSign(roomId: string): void;
  /** the person zoomed out far enough that the current rest no longer describes the view */
  onGoUp(): void;
}

export class OfficeScene {
  private app: Application | null = null;
  private mounting = false;
  private camera: Camera | null = null;
  private readonly world = new Container();
  private readonly floor = new Container();
  private readonly things = new Container();
  private readonly overlay = new Container();
  private textures: Textures = {};
  /** the pack's atlas: ours to free, since nothing else knows about it */
  private source: CanvasSource | null = null;
  private manifest: PackManifest | null = null;
  private city: CityLayout = layoutCity([]);
  private shape = '';
  private model: CityModel | null = null;
  /** keyed `machineId:deskId`: two machines can carry tabs with the same id without colliding */
  private desks = new Map<string, { id: string; view: DeskView; overlay: DeskOverlay; machineId: string; roomId: string }>();
  private machines = new Map<string, DrawnMachine>();
  private target: FocusTarget = { kind: 'city' };
  /** the scale the camera framed the current target at: zooming well below it means "go up" */
  private framedScale = 1;
  /** the person has panned or zoomed since the camera last framed something by itself */
  private userMoved = false;
  /** onGoUp already fired for this framing — one wheel gesture is many events */
  private wentUp = false;
  private destroyed = false;
  private readonly reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  frameMs = 0;

  constructor(private readonly handlers: SceneHandlers) {
    this.things.sortableChildren = true;
    // desk overlays over signs: a sign must never hide a marker of the room in front of it
    this.overlay.sortableChildren = true;
    this.world.addChild(this.floor, this.things);
  }

  /** Async because Pixi v8 picks its renderer asynchronously; safe against an unmount in between. */
  async mount(host: HTMLElement): Promise<void> {
    if (this.app || this.mounting || this.destroyed) return;
    this.mounting = true;
    const app = new Application();
    try {
      await app.init({ resizeTo: host, background: 0x0f1115, antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    } catch (err) {
      // neither WebGL nor canvas started: free the half-built app and let the page show its message,
      // leaving the scene mountable again (a stuck `mounting` would refuse every later attempt)
      this.mounting = false;
      app.destroy(true, { children: true });
      throw err;
    }
    this.mounting = false;
    if (this.destroyed) return app.destroy(true, { children: true });
    this.app = app;
    host.appendChild(app.canvas);
    const pack = generatedPack();
    this.manifest = pack.manifest;
    // built by hand rather than with Texture.from, which would leave the atlas in the global cache
    this.source = new CanvasSource({ resource: pack.canvas, scaleMode: 'nearest' });
    for (const [key, def] of Object.entries(pack.manifest.sprites)) {
      this.textures[key] = def.frames.map((f) => new Texture({ source: this.source!, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    }
    app.stage.addChild(this.world, this.overlay);
    this.camera = new Camera(app.canvas);
    this.camera.onUserMove = () => {
      this.userMoved = true;
      if (this.wentUp || this.target.kind === 'city' || !this.camera) return;
      if (this.camera.target.scale < this.framedScale * 0.6) {
        this.wentUp = true;
        this.handlers.onGoUp();
      }
    };
    // brackets our update and Pixi's render (priority LOW) to get the CPU cost of one frame
    let t0 = 0;
    app.ticker.add(() => (t0 = performance.now()), undefined, UPDATE_PRIORITY.INTERACTION);
    app.ticker.add(() => this.tick());
    app.ticker.add(() => (this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1), undefined, UPDATE_PRIORITY.UTILITY);
    const onVisibility = () => (document.hidden ? app.ticker.stop() : app.ticker.start());
    // a resized canvas leaves the framing stale; re-frame unless the person put the camera there
    const onResize = () => {
      if (this.target.kind !== 'city' || !this.userMoved) this.frameTarget(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    app.renderer.on('resize', onResize);
    // Pixi's `resizeTo` only listens to the WINDOW's resize; the host also changes size with no
    // window resize at all — focus mode hides the sidebar, the sidebar collapses — so watch the element.
    const observer = new ResizeObserver(() => app.resize());
    observer.observe(host);
    this.cleanup = () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      app.renderer.off('resize', onResize);
    };
    if (this.model) this.rebuild(this.model, true);
  }

  private cleanup: () => void = () => {};

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
    this.camera?.destroy();
    this.camera = null;
    this.app?.destroy(true, { children: true });
    this.app = null;
    for (const frames of Object.values(this.textures)) for (const texture of frames) texture.destroy();
    this.textures = {};
    this.source?.destroy();
    this.source = null;
  }

  get fps(): number {
    return this.app?.ticker.FPS ?? 0;
  }

  get rendererName(): string {
    return this.app?.renderer.name ?? '—';
  }

  /** Same machines, rooms and desks (ids, kinds, order) → only properties change; otherwise the city is rebuilt. */
  setModel(model: CityModel): void {
    const shape = shapeOf(model);
    this.model = model;
    if (!this.app) return;
    if (shape !== this.shape) return this.rebuild(model, this.shape === '');
    for (const machine of model.machines) {
      const drawn = this.machines.get(machine.id);
      if (!drawn) continue;
      // a machine going offline is not a new city: repaint its ground and dim its desks where they stand
      if (drawn.lit !== machine.lit) {
        drawn.lit = machine.lit;
        drawBlock(drawn.block, machine.lit, drawn.ground);
        for (const view of drawn.views) view.root.alpha = machine.lit ? 1 : UNLIT_ALPHA;
      }
      drawn.sign.apply(machine);
      machine.floor.rooms.forEach((room, i) => {
        // a room of an unlit machine is dark whatever its own project says
        const lit = room.lit && machine.lit;
        const drawnRoom = drawn.rooms[i];
        if (drawnRoom && drawnRoom.lit !== lit) {
          drawnRoom.lit = lit;
          drawRoom(drawnRoom.placed, lit, drawnRoom.ground);
        }
        drawn.signs[i]?.apply(room);
        for (const d of room.desks) {
          const desk = this.desks.get(deskKey(machine.id, d.id));
          desk?.view.apply(d);
          desk?.overlay.apply(d);
        }
      });
    }
  }

  /** Dev/test aid: forces one desk's hovered state (`null` clears it), so a screenshot can show it. */
  debugHover(deskId: string | null): void {
    for (const desk of this.desks.values()) desk.overlay.hovered = desk.id === deskId;
  }

  /**
   * Frames the city, a machine's block or a room. The page replays the URL's target on every
   * navigation, so an equal target is a no-op: re-framing would undo a camera the person moved.
   */
  focus(target: FocusTarget, snap = false): void {
    if (this.destroyed || sameFocus(target, this.target)) return;
    this.target = target;
    this.frameTarget(snap);
  }

  /** No camera yet (focused before `mount()` resolved): the target is stored and the rebuild frames it. */
  private frameTarget(snap: boolean): void {
    if (!this.camera) return;
    this.camera.frameBox(this.boxOf(this.target), snap);
    this.framedScale = this.camera.target.scale;
    this.userMoved = false;
    this.wentUp = false;
  }

  private boxOf(target: FocusTarget): Box {
    // the machine signs hang under their blocks, so a framed box reaches past the last block's ground
    const withSign = (b: Box): Box => ({ ...b, h: b.h + BLOCK_BOTTOM });
    const block = target.kind === 'city' ? undefined : this.city.blocks.find((b) => b.id === target.machineId);
    if (!block) return withSign(cityBounds(this.city, BLOCK_TOP));
    if (target.kind === 'room') {
      const room = block.floor.rooms.find((r) => r.id === target.roomId);
      if (room) return placedRoomBounds(roomOnCity(block, room), WALL_H + SIGN_H);
    }
    return withSign(blockBounds(block, BLOCK_TOP));
  }

  /** Whether the current model still has what the target names. */
  private exists(target: FocusTarget): boolean {
    if (target.kind === 'city') return true;
    const machine = this.model?.machines.find((m) => m.id === target.machineId);
    if (!machine) return false;
    return target.kind === 'machine' || machine.floor.rooms.some((r) => r.id === target.roomId);
  }

  /**
   * `first`: the very first city, which is framed and snapped to. Later rebuilds (a tab created, a
   * machine answering at last) re-frame the block or room the person is in, whose bounds may have
   * moved; on the city as a whole they only re-centre while nobody has moved the camera by hand.
   */
  private rebuild(model: CityModel, first: boolean): void {
    if (!this.manifest) return;
    this.shape = shapeOf(model);
    this.city = layoutCity(model.machines.map((m) => ({ id: m.id, rooms: m.floor.rooms.map((r) => ({ id: r.id, desks: r.desks.length })) })));
    for (const layer of [this.floor, this.things, this.overlay]) layer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.desks.clear();
    this.machines.clear();
    model.machines.forEach((machine, mi) => {
      const block = this.city.blocks[mi];
      // the block's ground goes down before its rooms, which paint over it; a click inside a room
      // lands on the room's own Graphics, so only what the rooms leave bare picks the machine
      const ground = drawBlock(block, machine.lit);
      ground.on('pointertap', () => this.clicked(() => this.handlers.onPickMachine(machine.id)));
      this.floor.addChild(ground);
      // over the block's FRONT corner, not its back one: markers all point up out of their desks,
      // so the ground down there is the one part of a block nothing of its own reaches into, and
      // the sign stays on its own machine instead of drifting over the street onto the next block
      const front = toScreen(block.origin.gx + block.width + BLOCK_MARGIN, block.origin.gy + block.height + BLOCK_MARGIN);
      const sign = new MachineSign(front, machine);
      sign.root.on('pointertap', () => this.clicked(() => this.handlers.onPickMachine(machine.id)));
      this.overlay.addChild(sign.root);
      const drawn: DrawnMachine = { block, ground, lit: machine.lit, sign, rooms: [], signs: [], views: [] };
      this.machines.set(machine.id, drawn);
      machine.floor.rooms.forEach((room, i) => {
        const placed = roomOnCity(block, block.floor.rooms[i]);
        const lit = room.lit && machine.lit;
        const roomGround = drawRoom(placed, lit);
        roomGround.on('pointertap', () => this.clicked(() => this.handlers.onPickRoom(machine.id, room.id)));
        this.floor.addChild(roomGround);
        drawn.rooms.push({ ground: roomGround, placed, lit });
        const corner = toScreen(placed.origin.gx, placed.origin.gy);
        const roomSign = new RoomSign({ x: corner.x, y: corner.y - WALL_H - 6 }, room);
        roomSign.root.on('pointertap', () => this.clicked(() => this.handlers.onPickSign(room.id)));
        drawn.signs.push(roomSign);
        this.overlay.addChild(roomSign.root);
        room.desks.forEach((d, j) => {
          const cell = { gx: placed.origin.gx + placed.layout.desks[j].gx, gy: placed.origin.gy + placed.layout.desks[j].gy };
          const at = toScreen(cell.gx, cell.gy);
          const view = new DeskView(d, this.textures, this.manifest!, this.reducedMotion);
          view.root.position.set(at.x, at.y);
          view.root.zIndex = depthOf(cell);
          // an unlit machine's furniture and people fade; their markers, in the overlay, do not
          view.root.alpha = machine.lit ? 1 : UNLIT_ALPHA;
          drawn.views.push(view);
          const overlay = new DeskOverlay({ x: at.x + view.head.x, y: at.y + view.head.y }, d);
          overlay.root.zIndex = 1;
          view.root.on('pointertap', () => this.clicked(() => this.handlers.onPickDesk(view.model.id, view.model.projectId)));
          view.root.on('pointerover', () => (overlay.hovered = true));
          view.root.on('pointerout', () => (overlay.hovered = false));
          this.things.addChild(view.root);
          this.overlay.addChild(overlay.root);
          this.desks.set(deskKey(machine.id, d.id), { id: d.id, view, overlay, machineId: machine.id, roomId: room.id });
        });
      });
    });
    // a target whose machine or room is gone falls back to the city, but the camera stays put
    if (!this.exists(this.target)) {
      this.target = { kind: 'city' };
      if (!first) return;
    }
    if (first || this.target.kind !== 'city' || !this.userMoved) this.frameTarget(first);
  }

  /** A press that dragged the camera is not a click. */
  private clicked(fn: () => void): void {
    if ((this.camera?.dragged ?? 0) < 5) fn();
  }

  private tick(): void {
    if (!this.camera || !this.app) return;
    const screen = this.app.screen;
    const view = this.camera.tick();
    this.world.scale.set(view.scale);
    this.world.position.set(view.x, view.y);
    const t = performance.now() / 1000;
    const target = this.target;
    // inside a room only that room is read in detail; wider, every desk once the zoom allows it
    const wide = target.kind !== 'room' && view.scale >= LABEL_SCALE;
    for (const { view: desk, overlay, machineId, roomId } of this.desks.values()) {
      desk.update();
      overlay.place(view, wide || (target.kind === 'room' && target.machineId === machineId && target.roomId === roomId), t, this.reducedMotion);
    }
    // `place` turns a sign off again when its anchor has left the viewport
    for (const [machineId, drawn] of this.machines) {
      const show = signVisibility(target, view.scale, machineId);
      drawn.sign.root.visible = show.machineSign;
      if (show.machineSign) drawn.sign.place(view, screen);
      for (const sign of drawn.signs) {
        sign.root.visible = show.roomSigns;
        if (show.roomSigns) sign.place(view, screen);
      }
    }
  }
}

const deskKey = (machineId: string, deskId: string) => `${machineId}:${deskId}`;

/** What a rebuild depends on: which machines, rooms and desks exist, not anything about their state. */
function shapeOf(city: CityModel): string {
  return city.machines.map((m) => `${m.id}{${m.floor.rooms.map((r) => `${r.id}[${r.desks.map((d) => `${d.id}:${d.kind}`).join(',')}]`).join('|')}}`).join(';');
}
