import type { Machine } from '../db/repositories/types.js';
import { wdaPorts, type WdaPorts } from './ports.js';
import type { Tunnel } from './tunnel.js';
import { WdaClient, type Orientation } from './wda-client.js';

export type SimStatus = { state: 'booting' | 'starting' | 'ready' | 'error'; message?: string; tail?: string[] };
export interface Screen {
  width: number;
  height: number;
  orientation: Orientation;
}

export interface Viewer {
  onFrame(frame: Buffer): void;
  onStatus(s: SimStatus): void;
  onScreen(s: Screen): void;
}

export interface SimulatorBackend {
  boot(machine: Machine, udid: string): Promise<void>;
  runnerAlive(machine: Machine, udid: string): Promise<boolean>;
  startRunner(machine: Machine, udid: string, ports: WdaPorts): Promise<void>;
  stopRunner(machine: Machine, udid: string): Promise<void>;
  runnerTail(machine: Machine, udid: string): Promise<string[]>;
  openTunnel(machine: Machine, ports: WdaPorts): Promise<Tunnel>;
  createClient(baseUrl: string): WdaClient;
  openMjpeg(port: number, onFrame: (f: Buffer) => void, onEnd: (err?: Error) => void): () => void;
}

export interface SessionHandle {
  client: WdaClient;
  readonly screen: Screen;
  setSettings(scale: number, quality: number): Promise<void>;
  refreshScreen(): Promise<Screen>;
  release(): void;
}

interface Options {
  idleMs?: number;
  readyTimeoutMs?: number;
  pollMs?: number;
  log?: (msg: string, meta?: object) => void;
}

const DEFAULT_SETTINGS = { mjpegServerFramerate: 30, mjpegScalingFactor: 50, mjpegServerScreenshotQuality: 40 };
const RECOVER_ATTEMPTS = 3;
const RECOVER_DELAY_MS = 2000;

interface Session {
  key: string;
  machine: Machine;
  udid: string;
  ports: WdaPorts;
  viewers: Set<Viewer>;
  starting: Promise<void> | null;
  ready: boolean;
  client: WdaClient | null;
  tunnel: Tunnel | null;
  closeMjpeg: (() => void) | null;
  screen: Screen;
  idleTimer: ReturnType<typeof setTimeout> | null;
  recovering: boolean;
  disposed: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uma sessão de WDA por máquina+udid, compartilhada entre viewers (refcount + ociosidade). */
export class SimulatorSessionManager {
  private sessions = new Map<string, Session>();
  private idleMs: number;
  private readyTimeoutMs: number;
  private pollMs: number;
  private log: (msg: string, meta?: object) => void;

  constructor(
    private backend: SimulatorBackend,
    opts: Options = {},
  ) {
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 90_000;
    this.pollMs = opts.pollMs ?? 1000;
    this.log = opts.log ?? (() => {});
  }

  private key(machineId: string, udid: string) {
    return `${machineId}:${udid.toUpperCase()}`;
  }

  isReady(machineId: string, udid: string): boolean {
    return this.sessions.get(this.key(machineId, udid))?.ready ?? false;
  }

  getClient(machineId: string, udid: string): WdaClient | null {
    const s = this.sessions.get(this.key(machineId, udid));
    return s?.ready ? s.client : null;
  }

  async acquire(machine: Machine, udid: string, viewer: Viewer): Promise<SessionHandle> {
    const key = this.key(machine.id, udid);
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        key,
        machine,
        udid,
        ports: wdaPorts(udid),
        viewers: new Set(),
        starting: null,
        ready: false,
        client: null,
        tunnel: null,
        closeMjpeg: null,
        screen: { width: 0, height: 0, orientation: 'portrait' },
        idleTimer: null,
        recovering: false,
        disposed: false,
      };
      this.sessions.set(key, s);
      s.viewers.add(viewer);
      s.starting = this.start(s).finally(() => (s!.starting = null));
    } else {
      s.viewers.add(viewer);
    }
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
    if (s.starting) {
      try {
        await s.starting;
      } catch (err) {
        s.viewers.delete(viewer);
        throw err;
      }
    } else if (s.ready) {
      viewer.onStatus({ state: 'ready' });
      viewer.onScreen(s.screen);
    }
    const session = s;
    let released = false;
    return {
      client: session.client!,
      get screen() {
        return session.screen;
      },
      setSettings: async (scale, quality) => {
        await session.client!.setSettings({ mjpegServerFramerate: 30, mjpegScalingFactor: scale, mjpegServerScreenshotQuality: quality });
      },
      refreshScreen: async () => {
        const [size, orientation] = await Promise.all([session.client!.windowSize(), session.client!.orientation()]);
        session.screen = { ...size, orientation };
        this.broadcast(session, (v) => v.onScreen(session.screen));
        return session.screen;
      },
      release: () => {
        if (released) return;
        released = true;
        this.release(session, viewer);
      },
    };
  }

  private broadcast(s: Session, fn: (v: Viewer) => void) {
    for (const v of s.viewers) {
      try {
        fn(v);
      } catch {
        /* viewer quebrado não derruba os outros */
      }
    }
  }

  private async start(s: Session): Promise<void> {
    const meta = { machineId: s.machine.id, udid: s.udid, ...s.ports };
    try {
      this.broadcast(s, (v) => v.onStatus({ state: 'booting' }));
      await this.backend.boot(s.machine, s.udid);
      this.broadcast(s, (v) => v.onStatus({ state: 'starting' }));
      if (!(await this.backend.runnerAlive(s.machine, s.udid))) {
        this.log('iniciando runner do WDA', meta);
        await this.backend.startRunner(s.machine, s.udid, s.ports);
      }
      await this.connect(s);
      const client = s.client!;
      await client.createSession();
      await client.setSettings(DEFAULT_SETTINGS);
      const [size, orientation] = await Promise.all([client.windowSize(), client.orientation()]);
      s.screen = { ...size, orientation };
      this.openStream(s);
      s.ready = true;
      this.log('simulador pronto', meta);
      this.broadcast(s, (v) => {
        v.onStatus({ state: 'ready' });
        v.onScreen(s.screen);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let tail: string[] | undefined;
      try {
        tail = await this.backend.runnerTail(s.machine, s.udid);
      } catch {
        tail = undefined;
      }
      this.log('falha ao subir simulador: ' + message, meta);
      this.broadcast(s, (v) => v.onStatus({ state: 'error', message, tail }));
      await this.dispose(s, { stopRunner: false });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /** Abre o túnel e espera o /status do WDA ficar pronto. */
  private async connect(s: Session): Promise<void> {
    const tunnel = await this.backend.openTunnel(s.machine, s.ports);
    s.tunnel = tunnel;
    tunnel.onClose((err) => {
      if (s.tunnel !== tunnel || s.disposed) return;
      void this.recover(s, err);
    });
    s.client = this.backend.createClient(`http://127.0.0.1:${tunnel.wdaPort}`);
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      try {
        if ((await s.client.status()).ready) return;
      } catch {
        /* ainda subindo */
      }
      if (Date.now() >= deadline) throw new Error('WDA não ficou pronto a tempo');
      await sleep(this.pollMs);
    }
  }

  private openStream(s: Session) {
    const port = s.tunnel!.mjpegPort;
    const close = this.backend.openMjpeg(
      port,
      (frame) => this.broadcast(s, (v) => v.onFrame(frame)),
      (err) => {
        if (s.closeMjpeg !== close || s.disposed) return;
        void this.recover(s, err);
      },
    );
    s.closeMjpeg = close;
  }

  /** Túnel ou stream caiu: reabre até RECOVER_ATTEMPTS vezes mantendo a sessão WDA. */
  private async recover(s: Session, cause?: Error): Promise<void> {
    if (s.recovering || s.disposed) return;
    s.recovering = true;
    s.ready = false;
    const meta = { machineId: s.machine.id, udid: s.udid };
    this.log('túnel/stream caiu, tentando recuperar: ' + (cause?.message ?? ''), meta);
    this.broadcast(s, (v) => v.onStatus({ state: 'starting', message: 'Reconectando ao simulador…' }));
    const sessionId = s.client?.sessionId ?? null;
    for (let i = 1; i <= RECOVER_ATTEMPTS; i++) {
      try {
        s.closeMjpeg?.();
        s.closeMjpeg = null;
        s.tunnel?.close();
        s.tunnel = null;
        await this.connect(s);
        s.client!.sessionId = sessionId;
        this.openStream(s);
        s.ready = true;
        s.recovering = false;
        this.broadcast(s, (v) => v.onStatus({ state: 'ready' }));
        return;
      } catch (err) {
        this.log(`recuperação ${i}/${RECOVER_ATTEMPTS} falhou: ${err instanceof Error ? err.message : err}`, meta);
        await sleep(RECOVER_DELAY_MS);
      }
    }
    s.recovering = false;
    this.broadcast(s, (v) => v.onStatus({ state: 'error', message: 'Conexão com o simulador perdida' }));
    await this.dispose(s, { stopRunner: false });
  }

  private release(s: Session, viewer: Viewer) {
    s.viewers.delete(viewer);
    if (s.viewers.size > 0 || s.disposed) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.viewers.size === 0) void this.dispose(s, { stopRunner: true });
    }, this.idleMs);
  }

  private async dispose(s: Session, opts: { stopRunner: boolean }): Promise<void> {
    if (s.disposed) return;
    s.disposed = true;
    s.ready = false;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.sessions.delete(s.key);
    s.closeMjpeg?.();
    s.closeMjpeg = null;
    try {
      await s.client?.deleteSession();
    } catch {
      /* WDA pode já ter morrido */
    }
    s.tunnel?.close();
    s.tunnel = null;
    if (opts.stopRunner) {
      try {
        await this.backend.stopRunner(s.machine, s.udid);
      } catch {
        /* máquina offline */
      }
    }
    this.log('sessão do simulador encerrada', { machineId: s.machine.id, udid: s.udid, stopRunner: opts.stopRunner });
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.dispose(s, { stopRunner: false })));
  }
}
