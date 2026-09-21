import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useFocusMode } from '../lib/focus';
import { useMonitor } from '../lib/monitor';
import { buildModel, missingTabIds, type FloorModel } from '../office/model';
import { OfficeScene } from '../office/scene/OfficeScene';
import { useOfficeSnapshot } from '../office/useOfficeSnapshot';

/** The office: one machine's floor, live. URL is the state: /office/:machineId?room=<projectId>&focus=1 */
export function OfficePage() {
  const { machineId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { machines, projects, statuses, loading } = useData();
  const { items, needsYou, tabState, connected } = useMonitor();
  const { focus, setFocus } = useFocusMode();
  const { snapshot, error, reload } = useOfficeSnapshot(machineId ?? null);
  // a callback ref, not useRef: the host <div> is absent on the first render (loading/no-machines/
  // permission branches return early below), and a ref alone would never re-trigger the mount effect
  // once it finally renders — which left the scene blank on a direct load or reload of the URL.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const room = params.get('room');
  const autoDrilled = useRef(false);
  const [failed, setFailed] = useState(false);
  // ids that already triggered a re-read for the current machine, so a permanently-missing tab
  // (e.g. one in an archived project the snapshot never lists) can't fire a GET on every render
  const notifiedMissing = useRef<{ machineId: string | undefined; ids: Set<string> }>({ machineId: undefined, ids: new Set() });

  const setRoom = useCallback(
    (id: string | null, replace = false) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set('room', id);
          else next.delete('room');
          return next;
        },
        { replace },
      ),
    [setParams],
  );

  // react-router's setSearchParams (and so setRoom, built on it) gets a new identity on every
  // query-string change — picking a room, leaving it, toggling focus mode. The scene's handlers read
  // through this ref instead, kept current every render, so the scene-mount effect further down never
  // has to depend on setRoom/navigate: depending on them would recreate the scene (destroy + mount a
  // blank canvas) on every query-string change, since setModel only fires again on a real model change.
  const handlers = useRef({
    onPickDesk: (tabId: string, projectId: string) => window.open(`/projects/${projectId}?tab=${tabId}`, '_blank', 'noopener'),
    onPickRoom: (id: string) => setRoom(id),
    onPickSign: (id: string) => navigate(`/projects/${id}`),
    onLeaveRoom: () => setRoom(null),
  });
  useEffect(() => {
    handlers.current = {
      onPickDesk: (tabId, projectId) => window.open(`/projects/${projectId}?tab=${tabId}`, '_blank', 'noopener'),
      onPickRoom: (id) => setRoom(id),
      onPickSign: (id) => navigate(`/projects/${id}`),
      onLeaveRoom: () => setRoom(null),
    };
  });

  // tabState reads a ref (lib/monitor.tsx), so it never changes identity; `items` is what actually
  // changes on a live push — keep it as a dep, or the model stops updating on monitor pushes.
  const model = useMemo(() => (snapshot ? buildModel(snapshot, tabState) : null), [snapshot, tabState, items]);
  // mirrors `model` for the scene-mount effect below: a scene created there (host/machineId change,
  // or recovering from a failed mount) must be seeded with whatever's already known, not sit blank
  // waiting for this push effect to fire again — it won't, since the model itself hasn't changed.
  const modelRef = useRef<FloorModel | null>(null);
  useEffect(() => {
    modelRef.current = model;
    if (model) sceneRef.current?.setModel(model);
  }, [model]);

  // a tab opened since the snapshot: re-read it, but only once per newly-missing id that actually
  // started a request — a re-read that bounced off an in-flight one must not be marked "asked", or
  // that tab is stuck on screen until the next 60s tick
  useEffect(() => {
    const mine = new Set(projects.filter((p) => p.machine_id === machineId && p.status !== 'archived').map((p) => p.id));
    const projectOf = (tabId: string) => items.find((i) => i.tab.id === tabId)?.project.id;
    const missing = missingTabIds(snapshot, items.map((i) => i.tab.id), mine, projectOf);
    if (notifiedMissing.current.machineId !== machineId) notifiedMissing.current = { machineId, ids: new Set() };
    const grew = missing.some((id) => !notifiedMissing.current.ids.has(id));
    if (grew && reload()) missing.forEach((id) => notifiedMissing.current.ids.add(id));
  }, [items, snapshot, projects, machineId, reload]);

  // auto-drill once per machine: exactly one room with desks opens straight into it
  useEffect(() => {
    if (!model || autoDrilled.current) return;
    autoDrilled.current = true;
    const withDesks = model.rooms.filter((r) => r.desks.length > 0);
    if (!room && withDesks.length === 1) setRoom(withDesks[0].id, true);
  }, [model, room, setRoom]);
  useEffect(() => {
    autoDrilled.current = false;
  }, [machineId]);

  const roomExists = !!model?.rooms.some((r) => r.id === room);
  // deliberate: frame once the first model arrives (the boolean, not the model itself, is what should retrigger this)
  const hasModel = model !== null;
  // mirrors the current focus target, for the same reason as modelRef above
  const focusRef = useRef<string | null>(null);
  useEffect(() => {
    focusRef.current = roomExists ? room : null;
    if (model) sceneRef.current?.focusRoom(focusRef.current);
  }, [room, roomExists, hasModel]);

  useEffect(() => {
    if (!host) return;
    setFailed(false);
    const scene = new OfficeScene({
      onPickDesk: (tabId, projectId) => handlers.current.onPickDesk(tabId, projectId),
      onPickRoom: (id) => handlers.current.onPickRoom(id),
      onPickSign: (id) => handlers.current.onPickSign(id),
      onLeaveRoom: () => handlers.current.onLeaveRoom(),
    });
    sceneRef.current = scene;
    // setModel/focusRoom are safe to call before mount() resolves — the scene stores them and
    // replays them once it can draw, so a scene created here is never left blank
    if (modelRef.current) scene.setModel(modelRef.current);
    scene.focusRoom(focusRef.current, true);
    // Pixi falls back from WebGL to canvas by itself; this only fires when neither could start
    scene.mount(host).catch(() => setFailed(true));
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [host, machineId]);

  // Esc leaves the room first, then focus mode; F toggles focus mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // a dialog already handled it — don't also kick out of the room
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key === 'Escape') {
        if (room) setRoom(null);
        else if (focus) setFocus(false);
      } else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setFocus(!focus);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [room, focus, setFocus, setRoom]);

  if (!can('projects', 'read') || !can('terminals', 'read')) return <Navigate to="/" replace />;
  if (loading) return <Message>Carregando…</Message>;
  if (machines.length === 0) {
    return (
      <Message>
        Nenhuma máquina cadastrada ainda. <Link className="text-accent hover:underline" to="/">Cadastre a primeira</Link> para ver o escritório.
      </Message>
    );
  }
  if (!machineId || !machines.some((m) => m.id === machineId)) return <Navigate to={`/office/${machines[0].id}`} replace />;

  // statuses[id] is a 'checking' | 'online' | 'offline' tag (lib/data.tsx), not an object with an
  // `online` field: only an explicit 'offline' should dim the floor and show the banner.
  const online = statuses[machineId] !== 'offline';
  const needsYouByMachine = (id: string) => needsYou.some((i) => i.machine.id === id);

  return (
    <div className="flex h-full flex-col">
      {!focus && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-bg-2 px-3 py-2 text-xs text-fg-muted">
          <span className="text-sm font-semibold text-fg">Escritório</span>
          {machines.length > 1 && (
            <select aria-label="Máquina" className="rounded border border-line bg-bg-3 px-2 py-1 text-fg" value={machineId} onChange={(e) => navigate(`/office/${e.target.value}`)}>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {needsYouByMachine(m.id) ? '● ' : ''}
                  {m.name}
                </option>
              ))}
            </select>
          )}
          {room && roomExists && (
            <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setRoom(null)}>
              ← voltar ao andar
            </button>
          )}
          <span className="ml-auto flex items-center gap-3">
            {!online && <span className="text-warn">máquina offline</span>}
            {snapshot && !snapshot.reachable && online && <span className="text-warn">sem resposta do tmux: abas aparecem como fechadas</span>}
            {!connected && <span className="text-warn">reconectando…</span>}
            <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setFocus(true)} title="Modo foco (F)">
              modo foco
            </button>
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={setHost} className={`absolute inset-0 overflow-hidden ${online ? '' : 'opacity-60'}`} />
        {focus && (
          <button className="absolute right-3 top-3 rounded bg-bg-2/80 px-2 py-1 text-xs text-fg-muted hover:text-fg" onClick={() => setFocus(false)}>
            sair do foco (Esc)
          </button>
        )}
        {failed && <Overlay>Seu navegador não conseguiu desenhar o escritório.</Overlay>}
        {error && <Overlay>{error}</Overlay>}
        {!error && !snapshot && <Overlay>Carregando o andar…</Overlay>}
        {model && model.rooms.length === 0 && <Overlay>Esta máquina ainda não tem projetos.</Overlay>}
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-muted">{children}</div>;
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{children}</div>;
}
