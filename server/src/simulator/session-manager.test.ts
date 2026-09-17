import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import type { SimulatorBackend, Viewer } from './session-manager.js';
import { SimulatorSessionManager } from './session-manager.js';
import { WdaClient } from './wda-client.js';

const machine: Machine = { id: 'm1', name: 'mac', host: 'mac.local', ssh_user: 'u', ssh_port: 22, type: 'ssh', os: 'macos', capabilities: ['wda'], checked_at: null, created_at: '' };
const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';

function makeBackend(overrides: Partial<SimulatorBackend> = {}) {
  let frameCb: ((f: Buffer) => void) | null = null;
  let endCb: ((e?: Error) => void) | null = null;
  const tunnelClose = vi.fn();
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status });
    if (url.endsWith('/status')) return body({ value: { ready: true } });
    if (url.endsWith('/session') && init?.method === 'POST') return body({ sessionId: 'S1', value: {} });
    if (url.endsWith('/window/size')) return body({ value: { width: 390, height: 844 } });
    if (url.endsWith('/orientation')) return body({ value: 'PORTRAIT' });
    return body({ value: null });
  }) as unknown as typeof fetch;
  const backend: SimulatorBackend = {
    boot: vi.fn(async () => {}),
    runnerAlive: vi.fn(async () => false),
    startRunner: vi.fn(async () => {}),
    stopRunner: vi.fn(async () => {}),
    runnerTail: vi.fn(async () => ['linha do runner']),
    openTunnel: vi.fn(async (_m, ports) => ({ wdaPort: ports.wdaPort, mjpegPort: ports.mjpegPort, close: tunnelClose, onClose() {} })),
    createClient: vi.fn((baseUrl: string) => new WdaClient(baseUrl, fetchFn)),
    openMjpeg: vi.fn((_port, onFrame, onEnd) => {
      frameCb = onFrame;
      endCb = onEnd;
      return vi.fn();
    }),
    ...overrides,
  };
  return { backend, fetchFn, tunnelClose, emitFrame: (f: Buffer) => frameCb?.(f), endStream: (e?: Error) => endCb?.(e) };
}

function makeViewer(): Viewer & { frames: Buffer[]; statuses: string[]; screens: unknown[] } {
  const v = {
    frames: [] as Buffer[],
    statuses: [] as string[],
    screens: [] as unknown[],
    onFrame(f: Buffer) {
      v.frames.push(f);
    },
    onStatus(s: { state: string }) {
      v.statuses.push(s.state);
    },
    onScreen(s: unknown) {
      v.screens.push(s);
    },
  };
  return v;
}

describe('SimulatorSessionManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sobe runner, túnel, sessão WDA e entrega status/screen/frames', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 1000 });
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    expect(b.backend.boot).toHaveBeenCalledWith(machine, UDID);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready']);
    expect(v.screens[0]).toEqual({ width: 390, height: 844, orientation: 'portrait' });
    expect(h.client.sessionId).toBe('S1');
    b.emitFrame(Buffer.from('f1'));
    expect(v.frames).toEqual([Buffer.from('f1')]);
    expect(mgr.isReady('m1', UDID)).toBe(true);
  });

  it('runner já vivo não é iniciado de novo', async () => {
    const b = makeBackend({ runnerAlive: vi.fn(async () => true) });
    const mgr = new SimulatorSessionManager(b.backend);
    await mgr.acquire(machine, UDID, makeViewer());
    expect(b.backend.startRunner).not.toHaveBeenCalled();
  });

  it('segundo viewer compartilha a sessão e recebe os mesmos frames', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend);
    const v1 = makeViewer();
    const v2 = makeViewer();
    await mgr.acquire(machine, UDID, v1);
    await mgr.acquire(machine, UDID, v2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v2.statuses).toEqual(['ready']);
    b.emitFrame(Buffer.from('x'));
    expect(v1.frames).toHaveLength(1);
    expect(v2.frames).toHaveLength(1);
  });

  it('último release encerra tudo depois de idleMs, e um novo acquire cancela', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 5000 });
    const h = await mgr.acquire(machine, UDID, makeViewer());
    h.release();
    await vi.advanceTimersByTimeAsync(4000);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    // novo viewer dentro da janela cancela o encerramento
    const h2 = await mgr.acquire(machine, UDID, makeViewer());
    await vi.advanceTimersByTimeAsync(6000);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    h2.release();
    await vi.advanceTimersByTimeAsync(5001);
    expect(b.backend.stopRunner).toHaveBeenCalledWith(machine, UDID);
    expect(b.tunnelClose).toHaveBeenCalled();
    const del = (b.fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE');
    expect(String(del?.[0])).toContain('/session/S1');
    expect(mgr.isReady('m1', UDID)).toBe(false);
  });

  it('status nunca pronto → error com o tail do runner e sessão descartada', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ value: { ready: false } }))) as unknown as typeof fetch;
    const b = makeBackend({ createClient: (baseUrl) => new WdaClient(baseUrl, fetchFn) });
    const mgr = new SimulatorSessionManager(b.backend, { readyTimeoutMs: 3000, pollMs: 1000 });
    const v = makeViewer();
    const p = mgr.acquire(machine, UDID, v);
    const rejected = expect(p).rejects.toThrow(/não ficou pronto/);
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(v.statuses.at(-1)).toBe('error');
    expect(mgr.isReady('m1', UDID)).toBe(false);
    expect(b.backend.runnerTail).toHaveBeenCalled();
  });

  it('stream MJPEG caindo reabre túnel e stream sem recriar a sessão WDA', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    b.endStream(new Error('caiu'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(2);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready', 'starting', 'ready']);
  });
});
