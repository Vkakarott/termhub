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
  /** Timeout de prontidão usado durante a recuperação (túnel/stream caiu), mais curto que o do start
   *  inicial: o runner já deveria estar de pé, então não vale a pena esperar os mesmos 90s por tentativa. */
  recoverReadyTimeoutMs?: number;
  pollMs?: number;
  log?: (msg: string, meta?: object) => void;
}

const DEFAULT_SETTINGS = { mjpegServerFramerate: 30, mjpegScalingFactor: 50, mjpegServerScreenshotQuality: 40 };
const RECOVER_ATTEMPTS = 3;
const RECOVER_DELAY_MS = 2000;
const DISPOSED_ERROR = 'sessão encerrada';

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
  recovering: Promise<void> | null;
  disposed: boolean;
  disposing: Promise<void> | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uma sessão de WDA por máquina+udid, compartilhada entre viewers (refcount + ociosidade). */
export class SimulatorSessionManager {
  private sessions = new Map<string, Session>();
  private idleMs: number;
  private readyTimeoutMs: number;
  private recoverReadyTimeoutMs: number;
  private pollMs: number;
  private log: (msg: string, meta?: object) => void;

  constructor(
    private backend: SimulatorBackend,
    opts: Options = {},
  ) {
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 90_000;
    this.recoverReadyTimeoutMs = opts.recoverReadyTimeoutMs ?? 15_000;
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
    // Uma sessão em processo de dispose ainda pode estar no mapa (só some quando o dispose termina,
    // depois do stopRunner) — espera terminar e tenta de novo, para não reaproveitar nem duplicar o runner.
    let s = this.sessions.get(key);
    while (s?.disposed) {
      if (s.disposing) await s.disposing;
      s = this.sessions.get(key);
    }
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
        recovering: null,
        disposed: false,
        disposing: null,
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
    const pending = s.starting ?? s.recovering;
    if (pending) {
      try {
        await pending;
      } catch (err) {
        s.viewers.delete(viewer);
        throw err;
      }
      if (s.disposed) {
        // A sessão não sobreviveu (start falhou de vez, ou a recuperação se esgotou): tenta de novo
        // do zero para este viewer, o que cria uma sessão nova.
        s.viewers.delete(viewer);
        return this.acquire(machine, udid, viewer);
      }
    } else if (s.ready) {
      this.notify(viewer, (v) => v.onStatus({ state: 'ready' }));
      this.notify(viewer, (v) => v.onScreen(s!.screen));
    }
    const session = s;
    let released = false;
    return {
      get client() {
        return session.client!;
      },
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

  private notify(viewer: Viewer, fn: (v: Viewer) => void) {
    try {
      fn(viewer);
    } catch {
      /* viewer quebrado não derruba os outros nem trava o refcount */
    }
  }

  private broadcast(s: Session, fn: (v: Viewer) => void) {
    for (const v of s.viewers) this.notify(v, fn);
  }

  // Extraídos em métodos (em vez de "s.tunnel?.close(); s.tunnel = null;" inline repetido) para não
  // depender da checagem de fluxo do TS sobre a propriedade através de awaits/chamadas.
  private closeTunnel(s: Session) {
    s.tunnel?.close();
    s.tunnel = null;
  }

  private closeMjpegStream(s: Session) {
    s.closeMjpeg?.();
    s.closeMjpeg = null;
  }

  private async start(s: Session): Promise<void> {
    const meta = { machineId: s.machine.id, udid: s.udid, ...s.ports };
    try {
      this.broadcast(s, (v) => v.onStatus({ state: 'booting' }));
      await this.backend.boot(s.machine, s.udid);
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      this.broadcast(s, (v) => v.onStatus({ state: 'starting' }));
      if (!(await this.backend.runnerAlive(s.machine, s.udid))) {
        if (s.disposed) throw new Error(DISPOSED_ERROR);
        this.log('iniciando runner do WDA', meta);
        await this.backend.startRunner(s.machine, s.udid, s.ports);
      }
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      await this.connect(s, this.readyTimeoutMs);
      const client = s.client!;
      await client.createSession();
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      await client.setSettings(DEFAULT_SETTINGS);
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      const [size, orientation] = await Promise.all([client.windowSize(), client.orientation()]);
      if (s.disposed) throw new Error(DISPOSED_ERROR);
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

  /** Abre o túnel e espera o /status do WDA ficar pronto; some com o que criou se a sessão for descartada no meio. */
  private async connect(s: Session, readyTimeoutMs: number): Promise<void> {
    const tunnel = await this.backend.openTunnel(s.machine, s.ports);
    if (s.disposed) {
      tunnel.close();
      throw new Error(DISPOSED_ERROR);
    }
    s.tunnel = tunnel;
    tunnel.onClose((err) => {
      if (s.tunnel !== tunnel || s.disposed) return;
      void this.recover(s, err);
    });
    s.client = this.backend.createClient(`http://127.0.0.1:${tunnel.wdaPort}`);
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      let ready = false;
      try {
        ready = (await s.client.status()).ready;
      } catch {
        /* ainda subindo */
      }
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      if (ready) return;
      if (Date.now() >= deadline) throw new Error('WDA não ficou pronto a tempo');
      await sleep(this.pollMs);
      if (s.disposed) throw new Error(DISPOSED_ERROR);
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

  /** Túnel ou stream caiu: reabre até RECOVER_ATTEMPTS vezes mantendo a sessão WDA. Reentrante-seguro. */
  private recover(s: Session, cause?: Error): Promise<void> {
    if (s.recovering) return s.recovering;
    if (s.disposed) return Promise.resolve();
    const p = this.doRecover(s, cause).finally(() => {
      if (s.recovering === p) s.recovering = null;
    });
    s.recovering = p;
    return p;
  }

  private async doRecover(s: Session, cause?: Error): Promise<void> {
    s.ready = false;
    const meta = { machineId: s.machine.id, udid: s.udid };
    this.log('túnel/stream caiu, tentando recuperar: ' + (cause?.message ?? ''), meta);
    this.broadcast(s, (v) => v.onStatus({ state: 'starting', message: 'Reconectando ao simulador…' }));
    const sessionId = s.client?.sessionId ?? null;
    for (let i = 1; i <= RECOVER_ATTEMPTS; i++) {
      if (s.disposed) return;
      // O runner pode ter morrido de vez na máquina (ex.: sessão tmux matada) — sem ele não adianta
      // reabrir túnel algum; desiste na hora em vez de gastar até recoverReadyTimeoutMs por tentativa.
      // Uma rejeição aqui (máquina inacessível, etc.) conta como "não vivo": sem o try/catch ela
      // escaparia de doRecover como unhandled rejection (chamado via "void this.recover(...)") e
      // deixaria a sessão presa no mapa, com os viewers travados em "Reconectando…" para sempre.
      let alive: boolean;
      try {
        alive = await this.backend.runnerAlive(s.machine, s.udid);
      } catch {
        alive = false;
      }
      if (!alive) {
        if (s.disposed) return;
        let tail: string[] | undefined;
        try {
          tail = await this.backend.runnerTail(s.machine, s.udid);
        } catch {
          tail = undefined;
        }
        if (s.disposed) return;
        this.log('runner do WDA morreu durante a recuperação', meta);
        this.closeTunnel(s);
        this.broadcast(s, (v) => v.onStatus({ state: 'error', message: 'Runner do WDA encerrou na máquina', tail }));
        if (s.client) s.client.sessionId = sessionId;
        await this.dispose(s, { stopRunner: false });
        return;
      }
      if (s.disposed) return;
      try {
        this.closeMjpegStream(s);
        this.closeTunnel(s);
        await this.connect(s, this.recoverReadyTimeoutMs);
        if (s.disposed) {
          this.closeTunnel(s);
          return;
        }
        s.client!.sessionId = sessionId;
        this.openStream(s);
        if (s.disposed) {
          this.closeMjpegStream(s);
          this.closeTunnel(s);
          return;
        }
        s.ready = true;
        this.broadcast(s, (v) => v.onStatus({ state: 'ready' }));
        return;
      } catch (err) {
        if (s.disposed) {
          this.closeTunnel(s);
          return;
        }
        this.log(`recuperação ${i}/${RECOVER_ATTEMPTS} falhou: ${err instanceof Error ? err.message : err}`, meta);
        await sleep(RECOVER_DELAY_MS);
        if (s.disposed) {
          this.closeTunnel(s);
          return;
        }
      }
    }
    // Esgotou as tentativas: fecha o que sobrou (a última tentativa pode ter deixado um túnel aberto
    // sem nunca ter ficado pronto) e apaga a sessão remota de fato, restaurando o sessionId salvo.
    this.closeTunnel(s);
    this.broadcast(s, (v) => v.onStatus({ state: 'error', message: 'Conexão com o simulador perdida' }));
    if (s.client) s.client.sessionId = sessionId;
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
    if (s.disposed) {
      if (s.disposing) await s.disposing;
      return;
    }
    s.disposed = true;
    s.ready = false;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    const p = this.doDispose(s, opts);
    s.disposing = p;
    await p;
  }

  /** Fecha tudo e só então tira a sessão do mapa (depois do stopRunner), para um acquire concorrente
   *  não achar o runner "vivo" nem duplicar o stopRunner. */
  private async doDispose(s: Session, opts: { stopRunner: boolean }): Promise<void> {
    this.closeMjpegStream(s);
    try {
      await s.client?.deleteSession();
    } catch {
      /* WDA pode já ter morrido */
    }
    this.closeTunnel(s);
    if (opts.stopRunner) {
      try {
        await this.backend.stopRunner(s.machine, s.udid);
      } catch {
        /* máquina offline */
      }
    }
    this.sessions.delete(s.key);
    this.log('sessão do simulador encerrada', { machineId: s.machine.id, udid: s.udid, stopRunner: opts.stopRunner });
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.dispose(s, { stopRunner: false })));
  }
}
