import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { Project, Tab } from '../lib/types';
import { TabBar } from './TabBar';
import { TerminalView } from './Terminal';
import { ConfirmDialog } from './Modal';
import { useData } from '../lib/data';

interface Props {
  project: Project;
  visible: boolean;
}

const activeKey = (projectId: string) => `termhub:active-tab:${projectId}`;

export function TerminalsView({ project, visible }: Props) {
  const { machines, missingTmux } = useData();
  const [searchParams, setSearchParams] = useSearchParams();
  const machine = machines.find((m) => m.id === project.machine_id);
  const noTmux = !!missingTmux[project.machine_id];
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(activeKey(project.id)));
  const [closing, setClosing] = useState<Tab | null>(null);
  // Terminais só montam depois da primeira vez visíveis (xterm não inicializa com display:none).
  const [shown, setShown] = useState(visible);
  useEffect(() => {
    if (visible) setShown(true);
  }, [visible]);
  const [error, setError] = useState<string | null>(null);

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

  // ?tab=<id> (vindo do card da task) ativa a tab e limpa o parâmetro.
  useEffect(() => {
    const wanted = searchParams.get('tab');
    if (!wanted || !tabs) return;
    if (tabs.some((t) => t.id === wanted)) setActiveId(wanted);
    else void load();
    setSearchParams((p) => {
      p.delete('tab');
      return p;
    }, { replace: true });
  }, [searchParams, tabs, setSearchParams, load]);

  // Garante uma tab ativa válida.
  useEffect(() => {
    if (!tabs) return;
    if (activeId && tabs.some((t) => t.id === activeId)) return;
    setActiveId(tabs[0]?.id ?? null);
  }, [tabs, activeId]);

  useEffect(() => {
    if (activeId) localStorage.setItem(activeKey(project.id), activeId);
  }, [activeId, project.id]);

  const newTab = useCallback(async () => {
    try {
      const { tab } = await api.projects.createTab(project.id);
      setTabs((t) => [...(t ?? []), tab]);
      setActiveId(tab.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao criar tab');
    }
  }, [project.id]);

  const rename = useCallback(async (id: string, name: string) => {
    setTabs((t) => (t ?? []).map((x) => (x.id === id ? { ...x, name } : x)));
    try {
      await api.tabs.rename(id, name);
    } catch {
      void load();
    }
  }, [load]);

  const closeTab = useCallback(
    async (tab: Tab) => {
      setClosing(null);
      const idx = (tabs ?? []).findIndex((t) => t.id === tab.id);
      const remaining = (tabs ?? []).filter((t) => t.id !== tab.id);
      setTabs(remaining);
      if (activeId === tab.id) setActiveId(remaining[Math.max(0, idx - 1)]?.id ?? remaining[0]?.id ?? null);
      try {
        await api.tabs.remove(tab.id);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Erro ao fechar tab');
        void load();
      }
    },
    [tabs, activeId, load],
  );

  // Marca a sessão como viva assim que o terminal conecta (evita esperar o próximo load).
  const markAlive = useCallback((id: string) => {
    setTabs((t) => (t ?? []).map((x) => (x.id === id && !x.alive ? { ...x, alive: true } : x)));
  }, []);

  // Atalhos: ⌘T nova tab, ⌘W fecha, ⌘1..9 troca (ctrl+shift+T/W como alternativa).
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
        const t = list.find((x) => x.id === activeId);
        if (t) setClosing(t);
      } else if (meta && /^[1-9]$/.test(e.key)) {
        const t = list[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          setActiveId(t.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, tabs, activeId, newTab]);

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'hidden'}`}>
      <TabBar
        tabs={tabs ?? []}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => void newTab()}
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
      <div className="relative min-h-0 flex-1">
        {tabs === null ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-dim">Carregando tabs…</div>
        ) : tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
            <p>Nenhum terminal aberto neste projeto.</p>
            <button className="btn-primary" onClick={() => void newTab()}>
              Abrir terminal <kbd className="ml-1 rounded bg-black/30 px-1 text-[10px]">⌘T</kbd>
            </button>
          </div>
        ) : shown ? (
          tabs.map((t) => (
            <TerminalView key={t.id} tabId={t.id} active={visible && t.id === activeId} onConnected={() => markAlive(t.id)} />
          ))
        ) : null}
      </div>
      <ConfirmDialog
        open={!!closing}
        title="Fechar tab"
        message={
          <>
            Fechar <strong>{closing?.name}</strong>? A sessão tmux <code className="font-mono text-xs">{closing?.tmux_session ?? ''}</code> será
            encerrada na máquina e o que estiver rodando nela será interrompido.
          </>
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
