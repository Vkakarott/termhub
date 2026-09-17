import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { SimulatorConnection, type SimState } from '../lib/simulator-connection';
import type { Screen, Simulator, Tab } from '../lib/types';
import { isAppShortcut } from './Terminal';

interface Props {
  tab: Tab;
  machineId: string;
  active: boolean;
  onTabChange: (tab: Tab) => void;
  onConnected?: () => void;
}

const STATE_LABEL: Record<SimState, string> = {
  connecting: 'Conectando…',
  booting: 'Ligando o simulador…',
  starting: 'Subindo o WebDriverAgent…',
  ready: 'Conectado',
  no_device: 'Escolha um simulador',
  error: 'Erro',
  offline: 'Offline',
  closed: 'Encerrado',
};

const QUALITY = {
  lan: { scale: 50, quality: 50, label: 'LAN' },
  remote: { scale: 25, quality: 30, label: 'Remoto' },
} as const;
type QualityKey = keyof typeof QUALITY;

const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);
const TAP_MAX_MS = 200;
const TAP_MAX_PX = 6;
const KEY_BATCH_MS = 50;

/** Seletor de aparelho (usado no estado vazio e na barra). */
function DevicePicker({ machineId, value, onPick }: { machineId: string; value: string | null; onPick: (udid: string) => void }) {
  const [list, setList] = useState<Simulator[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.machines
      .simulators(machineId)
      .then((r) => !cancelled && setList(r.simulators))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Erro ao listar simuladores'));
    return () => {
      cancelled = true;
    };
  }, [machineId]);
  if (error) return <span className="text-xs text-danger">{error}</span>;
  return (
    <select className="input h-7 max-w-[260px] py-0 text-xs" value={value ?? ''} onChange={(e) => e.target.value && onPick(e.target.value)} disabled={!list}>
      <option value="">{list ? 'Escolha um simulador…' : 'Carregando…'}</option>
      {list?.map((s) => (
        <option key={s.udid} value={s.udid}>
          {s.name} · {s.runtime}
          {s.state === 'Booted' ? ' · ligado' : ''}
        </option>
      ))}
    </select>
  );
}

export function SimulatorView({ tab, machineId, active, onTabChange, onConnected }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const connRef = useRef<SimulatorConnection | null>(null);
  const screenRef = useRef<Screen | null>(null);
  const [state, setState] = useState<SimState>('connecting');
  const [message, setMessage] = useState<string | undefined>();
  const [tail, setTail] = useState<string[] | undefined>();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [fps, setFps] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityKey>('lan');
  const frameCount = useRef(0);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Conexão: uma por tab+udid.
  useEffect(() => {
    if (!tab.simulator_udid) {
      setState('no_device');
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const conn = new SimulatorConnection(tab.id, {
      onFrame: (blob) => {
        frameCount.current += 1;
        void createImageBitmap(blob).then((bmp) => {
          if (!canvas || !ctx) return;
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
        });
      },
      onStatus: (s, m, t) => {
        setState(s);
        setMessage(m);
        setTail(t);
        if (s === 'ready') onConnectedRef.current?.();
      },
      onScreen: (s) => {
        screenRef.current = s;
        setScreen(s);
      },
      onToast: (m) => setToast(m),
    });
    connRef.current = conn;
    conn.connect();
    const fpsTimer = setInterval(() => {
      setFps(frameCount.current);
      frameCount.current = 0;
    }, 1000);
    return () => {
      clearInterval(fpsTimer);
      conn.close();
      connRef.current = null;
    };
  }, [tab.id, tab.simulator_udid]);

  // Aba escondida → pausa o stream.
  useEffect(() => {
    const conn = connRef.current;
    if (!conn) return;
    conn.send({ type: active && document.visibilityState === 'visible' ? 'resume' : 'pause' });
    const onVis = () => conn.send({ type: active && document.visibilityState === 'visible' ? 'resume' : 'pause' });
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [active, state]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const send = useCallback((msg: Parameters<SimulatorConnection['send']>[0]) => connRef.current?.send(msg), []);

  // Canvas px → pontos lógicos.
  const toPoint = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const scr = screenRef.current;
    if (!canvas || !scr) return null;
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * scr.width, y: ((e.clientY - r.top) / r.height) * scr.height };
  };

  // Mouse: tap curto ou drag amostrado.
  const gesture = useRef<{ points: { x: number; y: number; t: number }[]; last: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    canvasRef.current?.focus();
    const p = toPoint(e);
    if (!p) return;
    gesture.current = { points: [{ ...p, t: performance.now() }], last: performance.now() };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const g = gesture.current;
    if (!g) return;
    const now = performance.now();
    if (now - g.last < 16) return;
    const p = toPoint(e);
    if (!p) return;
    g.points.push({ ...p, t: now });
    g.last = now;
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = toPoint(e);
    if (p) g.points.push({ ...p, t: performance.now() });
    const first = g.points[0];
    const last = g.points[g.points.length - 1];
    const dist = Math.hypot(last.x - first.x, last.y - first.y);
    if (last.t - first.t < TAP_MAX_MS && dist < TAP_MAX_PX) send({ type: 'tap', x: first.x, y: first.y });
    else send({ type: 'drag', points: g.points });
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toPoint(e);
    if (!p) return;
    e.preventDefault();
    const dy = Math.max(-200, Math.min(200, -e.deltaY));
    const t = performance.now();
    send({ type: 'drag', points: [{ x: p.x, y: p.y, t }, { x: p.x, y: p.y + dy / 2, t: t + 40 }, { x: p.x, y: p.y + dy, t: t + 80 }] });
  };

  // Teclado: caracteres em lote, especiais na hora.
  const keyBatch = useRef('');
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushKeys = useCallback(() => {
    keyTimer.current = null;
    if (keyBatch.current) send({ type: 'keys', text: keyBatch.current });
    keyBatch.current = '';
  }, [send]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isAppShortcut(e.nativeEvent)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      flushKeys();
      send({ type: 'key', name: e.key });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      keyBatch.current += e.key;
      if (!keyTimer.current) keyTimer.current = setTimeout(flushKeys, KEY_BATCH_MS);
    }
  };

  const pickDevice = async (udid: string) => {
    try {
      const { tab: updated } = await api.tabs.update(tab.id, { simulator_udid: udid });
      onTabChange(updated);
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Erro ao trocar de simulador');
    }
  };

  const changeQuality = (q: QualityKey) => {
    setQuality(q);
    send({ type: 'settings', scale: QUALITY[q].scale, quality: QUALITY[q].quality });
  };

  const ready = state === 'ready';
  const portrait = !screen || screen.orientation === 'portrait';
  const aspect = screen ? `${screen.width} / ${screen.height}` : portrait ? '9 / 19.5' : '19.5 / 9';

  return (
    <div className={`absolute inset-0 flex flex-col ${active ? '' : 'hidden'}`}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-bg-2 px-2 text-xs">
        <DevicePicker machineId={machineId} value={tab.simulator_udid} onPick={(u) => void pickDevice(u)} />
        <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-ok' : state === 'error' || state === 'offline' ? 'bg-danger' : 'bg-warn'}`} />
        <span className="text-fg-muted">{STATE_LABEL[state]}</span>
        {ready && <span className="text-fg-dim">{fps} fps</span>}
        <span className="ml-auto flex items-center gap-1">
          <button className="btn-ghost px-2 py-0.5" disabled={!ready} onClick={() => send({ type: 'button', name: 'home' })} title="Home">
            Home
          </button>
          <button className="btn-ghost px-2 py-0.5" disabled={!ready} onClick={() => send({ type: 'button', name: 'lock' })} title="Bloquear">
            Bloquear
          </button>
          <button className="btn-ghost px-2 py-0.5" disabled={!ready} onClick={() => send({ type: 'rotate', orientation: portrait ? 'landscape' : 'portrait' })} title="Girar">
            Girar
          </button>
          <a className={`btn-ghost px-2 py-0.5 ${ready ? '' : 'pointer-events-none opacity-50'}`} href={api.tabs.screenshotUrl(tab.id)} download title="Baixar screenshot PNG">
            Screenshot
          </a>
          <select className="input h-7 py-0 text-xs" value={quality} onChange={(e) => changeQuality(e.target.value as QualityKey)} disabled={!ready} title="Qualidade do stream">
            {(Object.keys(QUALITY) as QualityKey[]).map((k) => (
              <option key={k} value={k}>
                {QUALITY[k].label}
              </option>
            ))}
          </select>
          {(state === 'error' || state === 'offline' || state === 'closed') && (
            <button className="btn-primary px-2 py-0.5" onClick={() => connRef.current?.retryNow()}>
              Reconectar
            </button>
          )}
        </span>
      </div>
      {toast && <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">{toast}</div>}
      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-3">
        {!tab.simulator_udid ? (
          <div className="flex flex-col items-center gap-2 text-sm text-fg-muted">
            <p>Esta aba ainda não tem um simulador.</p>
            <DevicePicker machineId={machineId} value={null} onPick={(u) => void pickDevice(u)} />
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              tabIndex={0}
              className="max-h-full max-w-full rounded-lg outline-none ring-accent focus:ring-1"
              style={{ aspectRatio: aspect, height: portrait ? '100%' : undefined, width: portrait ? undefined : '100%' }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
              onContextMenu={(e) => e.preventDefault()}
            />
            {!ready && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-fg-muted">
                <p>{STATE_LABEL[state]}</p>
                {message && <p className="text-xs text-danger">{message}</p>}
                {tail && tail.length > 0 && (
                  <pre className="max-h-48 max-w-[90%] overflow-auto rounded bg-bg-2 p-2 text-[10px] text-fg-dim">{tail.join('\n')}</pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
