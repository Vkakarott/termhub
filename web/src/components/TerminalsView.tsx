import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import {
  cellRects,
  initialFloatingRect,
  loadLayout,
  placeOf,
  reduce,
  sanitize,
  saveLayout,
  type Action,
  type Layout,
  type Preset,
  type Rect,
  type Size,
} from '../lib/layout';
import type { Project, Tab, TabKind } from '../lib/types';
import { TabBar } from './TabBar';
import { TerminalView } from './Terminal';
import { SimulatorView } from './SimulatorView';
import { PaneLayer, PANE_HEADER_HEIGHT } from './PaneLayer';
import { FloatingWindow, FLOATING_TITLE_HEIGHT } from './FloatingWindow';
import { ConfirmDialog } from './Modal';
import { useData } from '../lib/data';

interface Props {
  project: Project;
  visible: boolean;
}

export function TerminalsView({ project, visible }: Props) {
  const { machines, missingTmux } = useData();
  const [searchParams, setSearchParams] = useSearchParams();
  const machine = machines.find((m) => m.id === project.machine_id);
  const noTmux = !!missingTmux[project.machine_id];
  const canSimulator = !!machine?.capabilities.includes('wda');
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const [closing, setClosing] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tabs mount only after the section was visible once (xterm cannot initialize inside display:none).
  const [shown, setShown] = useState(visible);
  useEffect(() => {
    if (visible) setShown(true);
  }, [visible]);

  // --- Layout state -------------------------------------------------------
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size | null>(null);
  const [layout, setLayout] = useState<Layout>(() => loadLayout(project.id, [], null));
  const [floatingFocused, setFloatingFocused] = useState(false);
  const tabIds = useMemo(() => (tabs ?? []).map((t) => t.id), [tabs]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setArea({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-sanitize whenever the tab list or the area changes (deleted tabs, smaller window).
  useEffect(() => {
    if (!tabs) return;
    setLayout((l) => sanitize(l, tabIds, area));
  }, [tabs, tabIds, area]);

  // First load with the real tab list: pick up the stored layout (or migrate the old active-tab key).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!tabs || loadedFor.current === project.id) return;
    loadedFor.current = project.id;
    setLayout(loadLayout(project.id, tabIds, area));
  }, [tabs, tabIds, area, project.id]);

  useEffect(() => {
    if (loadedFor.current === project.id) saveLayout(project.id, layout);
  }, [layout, project.id]);

  const dispatch = useCallback((action: Action) => setLayout((l) => reduce(l, action, area)), [area]);

  const rects = useMemo(() => (area ? cellRects(layout.preset, area.width, area.height) : []), [area, layout.preset]);
  const headerH = layout.preset === 'single' ? 0 : PANE_HEADER_HEIGHT;

  /** Where a tab is drawn: its cell (minus the header) or the floating body; null = hidden. */
  const rectOf = (tabId: string): Rect | null => {
    const place = placeOf(layout, tabId);
    if (!place) return null;
    if (place.kind === 'floating' && layout.floating) {
      const f = layout.floating;
      return { x: f.x, y: f.y + FLOATING_TITLE_HEIGHT, w: f.w, h: Math.max(0, f.h - FLOATING_TITLE_HEIGHT) };
    }
    if (place.kind === 'cell') {
      const r = rects[place.cell];
      return r ? { x: r.x, y: r.y + headerH, w: r.w, h: Math.max(0, r.h - headerH) } : null;
    }
    return null;
  };

  const focusedTabId = layout.floating && floatingFocused ? layout.floating.tabId : layout.cells[layout.focusedCell] ?? null;

  // --- Data -----------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const r = await api.projects.tabs(project.id);
      setTabs(r.tabs);
      setReachable(r.reachable);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar tabs');
      setTabs([]);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // ?tab=<id> (from a task card) shows the tab in the focused cell and clears the param.
  useEffect(() => {
    const wanted = searchParams.get('tab');
    if (!wanted || !tabs) return;
    if (tabs.some((t) => t.id === wanted)) dispatch({ type: 'assign', tabId: wanted });
    else void load();
    setSearchParams(
      (p) => {
        p.delete('tab');
        return p;
      },
      { replace: true },
    );
  }, [searchParams, tabs, setSearchParams, load, dispatch]);

  const newTab = useCallback(
    async (kind: TabKind = 'terminal', cell?: number) => {
      try {
        const { tab } = await api.projects.createTab(project.id, { kind });
        setTabs((t) => [...(t ?? []), tab]);
        setLayout((l) => {
          const target = cell ?? (l.cells.indexOf(null) === -1 ? l.focusedCell : l.cells.indexOf(null));
          return reduce(l, { type: 'assignTo', cell: target, tabId: tab.id }, area);
        });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Erro ao criar tab');
      }
    },
    [project.id, area],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      setTabs((t) => (t ?? []).map((x) => (x.id === id ? { ...x, name } : x)));
      try {
        await api.tabs.rename(id, name);
      } catch {
        void load();
      }
    },
    [load],
  );

  const closeTab = useCallback(
    async (tab: Tab) => {
      setClosing(null);
      setTabs((t) => (t ?? []).filter((x) => x.id !== tab.id));
      dispatch({ type: 'closeTab', tabId: tab.id });
      try {
        await api.tabs.remove(tab.id);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Erro ao fechar tab');
        void load();
      }
    },
    [dispatch, load],
  );

  // Mark the session alive as soon as the tab connects (no need to wait for the next load).
  const markAlive = useCallback((id: string) => {
    setTabs((t) => (t ?? []).map((x) => (x.id === id && !x.alive ? { ...x, alive: true } : x)));
  }, []);

  const detach = useCallback(
    (tab: Tab, aspect: number) => {
      if (!area || tab.kind !== 'simulator') return;
      dispatch({ type: 'detach', tabId: tab.id, rect: initialFloatingRect(area, aspect) });
      setFloatingFocused(true);
    },
    [area, dispatch],
  );

  // Shortcuts: ⌘T new tab, ⌘W close focused, ⌘1..9 assign (ctrl+shift+T/W as alternatives).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      const list = tabs ?? [];
      const meta = e.metaKey && !e.ctrlKey && !e.altKey;
      const ctrlShift = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
      if ((meta && e.key === 't') || (ctrlShift && e.key === 'T')) {
        e.preventDefault();
        void newTab();
      } else if ((meta && e.key === 'w') || (ctrlShift && e.key === 'W')) {
        e.preventDefault();
        const t = list.find((x) => x.id === focusedTabId);
        if (t) setClosing(t);
      } else if (meta && /^[1-9]$/.test(e.key)) {
        const t = list[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          dispatch({ type: 'assign', tabId: t.id });
          setFloatingFocused(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, tabs, focusedTabId, newTab, dispatch]);

  const floatingTab = layout.floating ? (tabs ?? []).find((t) => t.id === layout.floating?.tabId) : undefined;

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'hidden'}`}>
      <TabBar
        tabs={tabs ?? []}
        activeId={focusedTabId}
        onScreen={(id) => placeOf(layout, id) !== null}
        preset={layout.preset}
        onPreset={(p: Preset) => dispatch({ type: 'setPreset', preset: p })}
        onSelect={(id) => {
          dispatch({ type: 'assign', tabId: id });
          setFloatingFocused(layout.floating?.tabId === id);
        }}
        onNew={() => void newTab()}
        onNewSimulator={() => void newTab('simulator')}
        canSimulator={canSimulator}
        onRename={(id, name) => void rename(id, name)}
        onClose={(id) => {
          const t = (tabs ?? []).find((x) => x.id === id);
          if (t) setClosing(t);
        }}
      />
      {noTmux && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          <strong>{machine?.name}</strong> está online mas não tem <code className="font-mono">tmux</code> instalado. Instale (ex.:{' '}
          <code className="font-mono">sudo apt install tmux</code>) para abrir terminais.
        </div>
      )}
      {!reachable && (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          Não foi possível consultar as sessões tmux nesta máquina (offline?). Os terminais podem não conectar.
        </div>
      )}
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            fechar
          </button>
        </div>
      )}
      <div ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden">
        {tabs === null ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-dim">Carregando tabs…</div>
        ) : tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
            <p>Nenhum terminal aberto neste projeto.</p>
            <button className="btn-primary" onClick={() => void newTab()}>
              Abrir terminal <kbd className="ml-1 rounded bg-black/30 px-1 text-[10px]">⌘T</kbd>
            </button>
          </div>
        ) : shown && area ? (
          <>
            {tabs.map((t) => {
              const r = rectOf(t.id);
              const place = placeOf(layout, t.id);
              const isFloating = place?.kind === 'floating';
              const active = visible && r !== null;
              return (
                <div
                  key={t.id}
                  className="absolute"
                  style={
                    r
                      ? { left: r.x, top: r.y, width: r.w, height: r.h, zIndex: isFloating ? 21 : 1 }
                      : { left: 0, top: 0, width: area.width, height: area.height, visibility: 'hidden', pointerEvents: 'none' }
                  }
                  onPointerDownCapture={() => {
                    if (place?.kind === 'cell') {
                      dispatch({ type: 'focus', cell: place.cell });
                      setFloatingFocused(false);
                    } else if (isFloating) setFloatingFocused(true);
                  }}
                >
                  {t.kind === 'simulator' ? (
                    <SimulatorView
                      tab={t}
                      machineId={project.machine_id}
                      active={active}
                      floating={isFloating}
                      onDetach={(aspect) => detach(t, aspect)}
                      onDock={() => {
                        dispatch({ type: 'dock' });
                        setFloatingFocused(false);
                      }}
                      onTabChange={(updated) => setTabs((list) => (list ?? []).map((x) => (x.id === updated.id ? { ...updated, alive: x.alive } : x)))}
                      onConnected={() => markAlive(t.id)}
                    />
                  ) : (
                    <TerminalView tabId={t.id} active={active} onConnected={() => markAlive(t.id)} />
                  )}
                </div>
              );
            })}
            <PaneLayer
              preset={layout.preset}
              rects={rects}
              cells={layout.cells}
              focusedCell={layout.focusedCell}
              tabs={tabs}
              onFocus={(cell) => {
                dispatch({ type: 'focus', cell });
                setFloatingFocused(false);
              }}
              onAssign={(cell, tabId) => dispatch({ type: 'assignTo', cell, tabId })}
              onClear={(cell) => dispatch({ type: 'clearCell', cell })}
              onNewTerminal={(cell) => void newTab('terminal', cell)}
            />
            {layout.floating && floatingTab && (
              <FloatingWindow
                rect={layout.floating}
                title={floatingTab.name}
                onMove={(x, y) => dispatch({ type: 'moveFloating', x, y })}
                onResize={(w, h) => dispatch({ type: 'resizeFloating', w, h })}
                onDock={() => {
                  dispatch({ type: 'dock' });
                  setFloatingFocused(false);
                }}
                onFocus={() => setFloatingFocused(true)}
              >
                {null}
              </FloatingWindow>
            )}
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={!!closing}
        title="Fechar tab"
        message={
          closing?.kind === 'simulator' ? (
            <>
              Fechar <strong>{closing?.name}</strong>? O simulador continua ligado na máquina; só a aba é removida.
            </>
          ) : (
            <>
              Fechar <strong>{closing?.name}</strong>? A sessão tmux <code className="font-mono text-xs">{closing?.tmux_session}</code> será
              encerrada na máquina e o que estiver rodando nela será interrompido.
            </>
          )
        }
        confirmLabel="Fechar tab"
        danger
        onCancel={() => setClosing(null)}
        onConfirm={() => {
          if (closing) void closeTab(closing);
        }}
      />
    </div>
  );
}
