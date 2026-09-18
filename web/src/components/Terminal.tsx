import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { TerminalConnection, type ConnectionState } from '../lib/terminal-connection';
import { api, ApiError } from '../lib/api';

interface Props {
  tabId: string;
  active: boolean;
  /** true when this is the tab that should own keyboard focus right now (the focused cell/floating window) */
  focused?: boolean;
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

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** Modificador que força a seleção do xterm quando o app está usando o mouse. */
const SELECT_MODIFIER = IS_MAC ? '⌥' : 'Shift';

function formatBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Files carried by a paste or drop (screenshot on the clipboard, files copied in Finder, dragged files). */
function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

function hasFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types ?? []).includes('Files');
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Atalhos globais que o xterm NÃO deve capturar (deixa subir para o app). */
export function isAppShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return false;
  if (e.metaKey && (e.key === 't' || e.key === 'w')) return true;
  if (e.metaKey && /^[1-9]$/.test(e.key)) return true;
  // ctrl+shift+t / ctrl+shift+w como alternativa quando o navegador captura cmd+t/cmd+w
  if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 'W')) return true;
  return false;
}

export function TerminalView({ tabId, active, focused, onConnected, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<TerminalConnection | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [attempt, setAttempt] = useState(0);
  /** o app em foco ligou o mouse tracking (cliques/arrasto vão para ele) */
  const [mouseApp, setMouseApp] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  /** aviso do upload de imagem colada: texto + tom */
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'ok' | 'danger' } | null>(null);
  const noticeTimer = useRef(0);
  /** a file drag is hovering the terminal */
  const [dragging, setDragging] = useState(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const activeRef = useRef(active);
  activeRef.current = active;

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
      // Apps que ligam mouse tracking (claude, vim, htop...) recebem o arrasto; ⌥ no Mac (Shift no resto) força a seleção do xterm.
      macOptionClickForcesSelection: true,
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

    // Cópia automática: ao soltar o mouse com texto selecionado. Escuta no window porque o arrasto pode
    // terminar fora do terminal; só copia se a seleção mudou desde o último mouseup (evita recopiar uma
    // seleção antiga em cliques fora do terminal) e se esta é a tab ativa.
    let selectionDirty = false;
    const selSub = term.onSelectionChange(() => {
      selectionDirty = true;
    });
    const copySelection = () => {
      if (!activeRef.current || !selectionDirty) return;
      selectionDirty = false;
      const text = term.getSelection();
      if (!text) return;
      void copyToClipboard(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
      });
    };
    window.addEventListener('mouseup', copySelection);

    // Cmd+V com imagem: envia para a máquina da tab e cola o caminho no terminal (o Claude Code lê o arquivo).
    const showNotice = (text: string, tone: 'info' | 'ok' | 'danger', ms?: number) => {
      window.clearTimeout(noticeTimer.current);
      setNotice({ text, tone });
      if (ms) noticeTimer.current = window.setTimeout(() => setNotice(null), ms);
    };
    // Uploads files (paste or drop) to the tab's machine one by one and pastes their paths into the prompt.
    let uploading = false;
    const attachFiles = async (files: File[]) => {
      if (uploading || files.length === 0) return;
      uploading = true;
      const total = files.reduce((n, f) => n + f.size, 0);
      const what = files.length === 1 ? (files[0].name || 'arquivo') : `${files.length} arquivos`;
      showNotice(`Enviando ${what}… ${formatBytes(total)}`, 'info');
      const paths: string[] = [];
      try {
        for (const f of files) {
          const r = await api.tabs.pasteFile(tabId, f, f.name || undefined);
          paths.push(r.path);
        }
        term.paste(`${paths.join(' ')} `);
        showNotice(files.length === 1 ? 'Arquivo anexado' : `${files.length} arquivos anexados`, 'ok', 2500);
      } catch (err) {
        if (paths.length) term.paste(`${paths.join(' ')} `); // keep what did go through
        showNotice(err instanceof ApiError ? err.message : 'Falha ao enviar o arquivo', 'danger', 5000);
      } finally {
        uploading = false;
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      const files = filesFromTransfer(e.clipboardData);
      if (files.length === 0) return; // plain text: xterm pastes it
      e.preventDefault();
      e.stopPropagation();
      void attachFiles(files);
    };
    // capture: runs before xterm's own paste listener (on its inner textarea)
    el.addEventListener('paste', onPaste, true);

    // Drag and drop: highlight while a file drag hovers the terminal; drop uploads.
    let dragDepth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      dragDepth = 0;
      setDragging(false);
      const files = filesFromTransfer(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      term.focus();
      void attachFiles(files);
    };
    el.addEventListener('dragenter', onDragEnter);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);

    // Detecta quando o app liga/desliga o mouse tracking (DECSET/DECRST ?1000/?1002/?1003) para mostrar a dica.
    const syncMouseMode = () => setMouseApp(term.modes.mouseTrackingMode !== 'none');
    const onPrivateMode = (params: (number | number[])[]) => {
      if (params.some((p) => p === 1000 || p === 1002 || p === 1003)) queueMicrotask(syncMouseMode);
      return false; // deixa o xterm processar normalmente
    };
    const modeSubs = [
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, onPrivateMode),
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, onPrivateMode),
    ];
    const safeFit = () => {
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* terminal ainda sem renderer (ex.: container oculto) */
      }
    };
    safeFit();

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
      raf = requestAnimationFrame(safeFit);
    });
    ro.observe(el);

    const onOnline = () => conn.retryNow();
    window.addEventListener('online', onOnline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('mouseup', copySelection);
      selSub.dispose();
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('dragenter', onDragEnter);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
      window.clearTimeout(noticeTimer.current);
      for (const sub of modeSubs) sub.dispose();
      window.clearTimeout(copiedTimer.current);
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

  // Ao ativar a tab: reajusta tamanho (não mexe no foco do teclado — isso é o `focused` abaixo,
  // senão a última tab montada rouba o foco de quem está de fato na célula focada).
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* container oculto */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  // Foco do teclado segue a célula focada (ou a janela flutuante), não a simples transição
  // active=false→true de toda tab montada.
  useEffect(() => {
    if (!focused) return;
    const id = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [focused]);

  const badge =
    state === 'connected'
      ? 'bg-ok/15 text-ok'
      : state === 'offline' || state === 'closed'
        ? 'bg-danger/15 text-danger'
        : 'bg-warn/15 text-warn';

  return (
    <div className="absolute inset-0 flex flex-col">
      <div ref={containerRef} className="relative min-h-0 flex-1 bg-bg" onClick={() => termRef.current?.focus()}>
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-fg">
            Solte para anexar ao terminal
          </div>
        )}
      </div>
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
        {notice ? (
          <span className={notice.tone === 'ok' ? 'text-ok' : notice.tone === 'danger' ? 'text-danger' : 'text-fg-muted'}>{notice.text}</span>
        ) : copied ? (
          <span className="text-ok">Copiado</span>
        ) : mouseApp ? (
          <span title={`O programa em execução está usando o mouse. Segure ${SELECT_MODIFIER} ao arrastar para selecionar texto; a seleção é copiada ao soltar.`}>
            app usa o mouse · {SELECT_MODIFIER} + arrastar seleciona
          </span>
        ) : null}
        <span className="ml-auto font-mono">tmux</span>
      </div>
    </div>
  );
}
