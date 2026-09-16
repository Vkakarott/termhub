import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { TerminalConnection, type ConnectionState } from '../lib/terminal-connection';

interface Props {
  tabId: string;
  active: boolean;
  onConnected?: () => void;
  onExit?: () => void;
}

const THEME = {
  background: '#0f1115',
  foreground: '#e6e8ee',
  cursor: '#e6e8ee',
  cursorAccent: '#0f1115',
  selectionBackground: 'rgba(79,140,255,0.35)',
  black: '#1e222b',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: 'Conectando…',
  connected: 'Conectado',
  reconnecting: 'Reconectando…',
  offline: 'Offline',
  closed: 'Sessão encerrada',
};

/** Atalhos globais que o xterm NÃO deve capturar (deixa subir para o app). */
function isAppShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return false;
  if (e.metaKey && (e.key === 't' || e.key === 'w')) return true;
  if (e.metaKey && /^[1-9]$/.test(e.key)) return true;
  // ctrl+shift+t / ctrl+shift+w como alternativa quando o navegador captura cmd+t/cmd+w
  if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 'W')) return true;
  return false;
}

export function TerminalView({ tabId, active, onConnected, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<TerminalConnection | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [attempt, setAttempt] = useState(0);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new XTerm({
      theme: THEME,
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "SF Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* fallback para renderer DOM/canvas */
    }
    term.attachCustomKeyEventHandler((e) => !isAppShortcut(e));
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const conn = new TerminalConnection(tabId, {
      onData: (data) => term.write(data),
      onState: (s, a) => {
        setState(s);
        setAttempt(a);
        if (s === 'connected') onConnectedRef.current?.();
      },
      onExit: () => onExitRef.current?.(),
    });
    connRef.current = conn;
    conn.connect({ cols: term.cols, rows: term.rows });

    const dataSub = term.onData((d) => conn.send(d));
    const resizeSub = term.onResize(({ cols, rows }) => conn.sendResize(cols, rows));

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
      });
    });
    ro.observe(el);

    const onOnline = () => conn.retryNow();
    window.addEventListener('online', onOnline);

    return () => {
      window.removeEventListener('online', onOnline);
      ro.disconnect();
      cancelAnimationFrame(raf);
      dataSub.dispose();
      resizeSub.dispose();
      conn.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      connRef.current = null;
    };
  }, [tabId]);

  // Ao ativar a tab: reajusta tamanho e foca.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  const badge =
    state === 'connected'
      ? 'bg-ok/15 text-ok'
      : state === 'offline' || state === 'closed'
        ? 'bg-danger/15 text-danger'
        : 'bg-warn/15 text-warn';

  return (
    <div className={`absolute inset-0 flex flex-col ${active ? '' : 'invisible'}`}>
      <div ref={containerRef} className="min-h-0 flex-1 bg-bg" onClick={() => termRef.current?.focus()} />
      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-line bg-bg-2 px-2 text-[11px] text-fg-dim">
        <span className={`rounded px-1.5 py-px font-medium ${badge}`}>
          {STATE_LABEL[state]}
          {state === 'reconnecting' && attempt > 0 ? ` (${attempt})` : ''}
        </span>
        {(state === 'offline' || state === 'closed') && (
          <button className="text-accent hover:underline" onClick={() => connRef.current?.retryNow()}>
            Reconectar
          </button>
        )}
        <span className="ml-auto font-mono">tmux</span>
      </div>
    </div>
  );
}
