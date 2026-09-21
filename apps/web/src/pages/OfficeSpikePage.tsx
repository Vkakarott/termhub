/**
 * SPIKE (throwaway): /spike/office — one isometric room per project, people driven live by the
 * monitor. `?demo=N` swaps the real tabs for N synthetic ones whose states keep changing, to
 * measure the renderer at a scale the account does not have yet.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMonitor } from '../lib/monitor';
import { useData } from '../lib/data';
import { emptyMonitorHint } from '../lib/needs-you';
import { TAB_STATE_LABEL, type TabState } from '../lib/types';
import { OfficeScene, type DeskInput } from '../office/OfficeScene';

const STATES: Array<TabState | null> = ['working', 'working', 'working', 'waiting_input', 'waiting_permission', 'idle', 'idle', 'error', null];
const LEGEND: Array<[TabState, string]> = [
  ['working', 'bg-ok'],
  ['waiting_input', 'bg-warn'],
  ['waiting_permission', 'bg-attention'],
  ['idle', 'bg-fg-dim'],
  ['error', 'bg-danger'],
];

function demoDesks(count: number): DeskInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `demo-${i}`,
    name: `aba ${i + 1}`,
    state: STATES[i % STATES.length],
    kind: i % 11 === 10 ? 'phone' : 'person',
  }));
}

export function OfficeSpikePage() {
  const { items, connected } = useMonitor();
  const { machines } = useData();
  const [params, setParams] = useSearchParams();
  const demo = Math.min(2000, Math.max(0, Number(params.get('demo')) || 0));
  const [projectId, setProjectId] = useState<string | null>(null);
  const [fake, setFake] = useState<DeskInput[]>([]);
  const [hud, setHud] = useState({ fps: 0, ms: 0, renderer: '—' });
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const tabsRef = useRef(new Map<string, string>());

  const projects = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; count: number }>();
    for (const i of items) {
      const p = byId.get(i.project.id) ?? { id: i.project.id, label: `${i.machine.name} / ${i.project.name}`, count: 0 };
      p.count++;
      byId.set(i.project.id, p);
    }
    return [...byId.values()].sort((a, b) => b.count - a.count);
  }, [items]);
  const current = projectId ?? projects[0]?.id ?? null;

  const desks = useMemo<DeskInput[]>(() => {
    if (demo) return fake;
    return items
      .filter((i) => i.project.id === current)
      .sort((a, b) => a.tab.position - b.tab.position)
      .map((i) => ({ id: i.tab.id, name: i.tab.name, state: i.tab.state, kind: i.tab.kind === 'simulator' ? 'phone' : 'person' }));
  }, [demo, fake, items, current]);

  useEffect(() => {
    tabsRef.current = new Map(items.map((i) => [i.tab.id, i.project.id]));
  }, [items]);

  useEffect(() => {
    if (!hostRef.current) return;
    const scene = new OfficeScene((tabId) => {
      const pid = tabsRef.current.get(tabId);
      if (pid) window.open(`/projects/${pid}?tab=${tabId}`, '_blank', 'noopener');
    });
    sceneRef.current = scene;
    void scene.mount(hostRef.current);
    const timer = setInterval(() => setHud({ fps: Math.round(scene.fps), ms: scene.frameMs, renderer: scene.rendererName }), 500);
    return () => {
      clearInterval(timer);
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setDesks(desks);
  }, [desks]);

  // demo: a tenth of the room changes state every 400 ms, the same shape of update a push causes
  useEffect(() => {
    if (!demo) return;
    setFake(demoDesks(demo));
    const timer = setInterval(() => {
      setFake((list) => list.map((d) => (Math.random() < 0.1 ? { ...d, state: STATES[Math.floor(Math.random() * STATES.length)] } : d)));
    }, 400);
    return () => clearInterval(timer);
  }, [demo]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-bg-2 px-3 py-2 text-xs text-fg-muted">
        <span className="rounded bg-attention/20 px-1.5 py-0.5 font-semibold text-attention">SPIKE</span>
        {demo ? (
          <span>demo: {demo} abas sintéticas</span>
        ) : (
          <select className="rounded border border-line bg-bg-3 px-2 py-1 text-fg" value={current ?? ''} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 && <option value="">nenhuma aba com estado</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.count})
              </option>
            ))}
          </select>
        )}
        {[0, 40, 200, 1000].map((n) => (
          <button key={n} className={`rounded px-2 py-1 hover:bg-bg-3 ${demo === n ? 'bg-bg-3 text-fg' : ''}`} onClick={() => setParams(n ? { demo: String(n) } : {})}>
            {n ? `demo ${n}` : 'ao vivo'}
          </button>
        ))}
        <button className="rounded px-2 py-1 hover:bg-bg-3" onClick={() => sceneRef.current?.fit()}>
          enquadrar
        </button>
        <span className="ml-auto flex items-center gap-3">
          {LEGEND.map(([s, c]) => (
            <span key={s} className="flex items-center gap-1">
              <i className={`inline-block h-2 w-2 rounded-full ${c}`} />
              {TAB_STATE_LABEL[s]}
            </span>
          ))}
          <span className="font-mono text-fg">
            {hud.fps} fps · {hud.ms.toFixed(1)} ms · {hud.renderer} · {desks.length} mesas · ws {connected ? 'on' : 'off'}
          </span>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full overflow-hidden" />
        {!demo && desks.length === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-12 mx-auto max-w-md rounded-lg border border-line bg-bg-2 px-4 py-3 text-center text-xs text-fg-muted">
            A sala está vazia porque nenhuma tab reportou estado ao monitor.
            {emptyMonitorHint(machines) ? ` ${emptyMonitorHint(machines)}` : ' Abra uma tab e rode algo nela para a primeira mesa aparecer.'}
          </p>
        )}
      </div>
    </div>
  );
}
