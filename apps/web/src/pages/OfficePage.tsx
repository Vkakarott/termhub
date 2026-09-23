import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useFocusMode } from '../lib/focus';
import { useMonitor } from '../lib/monitor';
import type { Machine } from '../lib/types';
import { buildCityModel, missingTabIds, resolveFocus, sameFocus, type CityModel, type FocusTarget, type MachineEntry, type MachineModel } from '../office/model';
import { OfficeScene } from '../office/scene/OfficeScene';
import { useOfficeSnapshots, type MachineSnapshotState } from '../office/useOfficeSnapshots';

/**
 * The office: the whole account as a city, live. The URL is the state, and each of its rests is a
 * place the camera stands — /office the city, /office/:machineId a block, ?room=<projectId> a room
 * inside it, ?focus=1 focus mode. Moving between rests only moves the camera: one scene is built
 * per visit and kept, so the canvas never blanks on the way down or up.
 */
export function OfficePage() {
  const { machineId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can, user, publicCityUrl } = useAuth();
  const { machines, projects, statuses, loading } = useData();
  const { items, tabState, connected } = useMonitor();
  const { focus, setFocus } = useFocusMode();
  // a fresh array every render is fine: the hook keys on the sorted ids, not on this identity
  const { byMachine, reload } = useOfficeSnapshots(machines.map((m) => m.id));
  // a callback ref, not useRef: the host <div> is absent on the first render (loading/no-machines/
  // permission branches return early below), and a ref alone would never re-trigger the mount effect
  // once it finally renders — which left the scene blank on a direct load or reload of the URL.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const room = params.get('room');
  const [failed, setFailed] = useState(false);

  const entries = useMemo(
    (): MachineEntry[] =>
      machines.map((m) => ({
        id: m.id,
        name: m.name,
        // statuses[id] is a 'checking' | 'online' | 'offline' tag (lib/data.tsx), not an object with
        // an `online` field: only an explicit 'offline' darkens a block and shows the banner.
        online: statuses[m.id] !== 'offline',
        snapshot: byMachine[m.id]?.snapshot ?? null,
        failed: byMachine[m.id]?.failed ?? false,
      })),
    [machines, statuses, byMachine],
  );
  // tabState reads a ref (lib/monitor.tsx), so it never changes identity; `items` is what actually
  // changes on a live push — keep it as a dep, or the model stops updating on monitor pushes.
  const city = useMemo(() => buildCityModel(entries, tabState), [entries, tabState, items]);

  // mirrors `city` for the scene-mount effect below: a scene created there (the host element
  // arriving, a remount after a failed one) must be seeded with whatever is already known, not sit
  // blank waiting for this effect to fire again — it won't, the model itself has not changed.
  const cityRef = useRef<CityModel>(city);
  useEffect(() => {
    cityRef.current = city;
    sceneRef.current?.setModel(city);
  }, [city]);

  // What the URL asks the camera to frame, against what exists: an unknown machine or a ?room= of
  // another machine falls back on its own (office/model.ts), so neither can throw here.
  const target = resolveFocus(city, machineId, room);
  // mirrors the target for the same reason as cityRef. The object itself is rebuilt on every render
  // — a poll brings a fresh snapshot — so the scene is only told when the target changed BY VALUE:
  // re-framing an equal target would undo a camera the person moved by hand.
  const targetRef = useRef<FocusTarget>(target);
  useEffect(() => {
    if (sameFocus(target, targetRef.current)) return;
    targetRef.current = target;
    sceneRef.current?.focus(target);
  });

  // Every move keeps the rest of the query string — ?focus=1 above all: a screen left in focus mode
  // must stay in it through a block, a room and the way back up. `room` is the only key this page owns.
  const go = useCallback(
    (id: string | null, roomId: string | null, replace = false) => {
      const next = new URLSearchParams(params);
      if (roomId) next.set('room', roomId);
      else next.delete('room');
      const query = next.toString();
      navigate(`/office${id ? `/${id}` : ''}${query ? `?${query}` : ''}`, { replace });
    },
    [navigate, params],
  );

  // a rest the person asked for by hand, tracked PER MACHINE id: the auto-drill below must not undo
  // it by opening a room again. A click on a block, or a step up from a room, marks that machine's
  // id; a different machine reached later — a direct load, Back/Forward — is never affected by what
  // happened on another one (a single shared flag used to leak across machines this way).
  const byHand = useRef(new Set<string>());
  /**
   * The ladder: room -> machine -> city -> out of focus mode. Going up replaces, or Back would walk
   * straight back into the room that was just left. With a single machine the city rung is skipped:
   * /office would auto-drill straight back into that machine.
   *
   * `camera` is set only by the scene's own zoom-out gesture (a wheel/pinch on the canvas): it climbs
   * the same room -> machine -> city rungs, but never takes the last one — leaving focus mode is a
   * deliberate act (Esc, the "sair do foco" button), not something a zoom gesture should do by
   * itself. Esc and the breadcrumb call `up()` plain, so they still walk the full ladder.
   */
  const up = (opts: { camera?: boolean } = {}) => {
    if (target.kind === 'room') {
      byHand.current.add(target.machineId);
      go(target.machineId, null, true);
    } else if (machineId && machines.length > 1) {
      go(null, null, true);
    } else if (!opts.camera && focus) {
      setFocus(false);
    }
  };

  // react-router's `navigate` gets a new identity on every pathname change, and `useSearchParams` on
  // every query-string change — so `go`, and everything built on it, is new after every move. The
  // scene and the key listener call through this ref, re-synced after every render, which is what
  // lets the scene-mount effect below depend on the host element ALONE: a handler in its dependency
  // list would destroy the city and mount a blank canvas on every click.
  const actions = {
    onPickDesk: (tabId: string, projectId: string) => window.open(`/projects/${projectId}?tab=${tabId}`, '_blank', 'noopener'),
    onPickRoom: (id: string, roomId: string) => go(id, roomId),
    onPickMachine: (id: string) => {
      byHand.current.add(id);
      go(id, null);
    },
    onPickSign: (roomId: string) => navigate(`/projects/${roomId}`),
    onGoUp: () => up({ camera: true }),
    onEscape: () => up(),
    toggleFocus: () => setFocus(!focus),
  };
  const handlers = useRef(actions);
  useEffect(() => {
    handlers.current = actions;
  });

  // a tab opened since a snapshot: re-read THAT machine, and only once per newly-missing id that
  // really started a request — a re-read that bounced off an in-flight one must not be marked
  // "asked", or that tab is stuck on screen until the machine's next 60 s tick
  const notified = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    const tabIds = items.map((i) => i.tab.id);
    const projectOf = (tabId: string) => items.find((i) => i.tab.id === tabId)?.project.id;
    for (const machine of machines) {
      const mine = new Set(projects.filter((p) => p.machines.some((l) => l.machine_id === machine.id) && p.status !== 'archived').map((p) => p.id));
      const missing = missingTabIds(byMachine[machine.id]?.snapshot ?? null, tabIds, mine, projectOf);
      if (missing.length === 0) continue;
      const asked = notified.current.get(machine.id) ?? new Set<string>();
      notified.current.set(machine.id, asked);
      if (missing.some((id) => !asked.has(id)) && reload(machine.id)) for (const id of missing) asked.add(id);
    }
  }, [items, byMachine, machines, projects, reload]);

  // Auto-drill: what is not a choice is not asked. /office with a single machine IS that machine,
  // and a machine with a single room that has desks is that room. At most once per arrival at a
  // rest (`drilled`), and never after a click on a block or a step up the ladder (`byHand`) — those
  // name the rest the person wants to stand at. `byHand` is consumed at EVERY decision point for
  // THIS machine id, including the short-circuit, so a mark left by an earlier visit to a different
  // machine can never decide this one's drill, and a stale mark never lingers past its own machine.
  const drilled = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    if (!machineId) {
      drilled.current = null;
      if (machines.length === 1) go(machines[0].id, room, true);
      return;
    }
    // standing in a room IS having arrived at its machine: without this, stepping out to the block
    // through the breadcrumb (from a pasted v1 link, Back, or a room entered straight from the
    // city) looked like a first arrival and drilled right back into the only room — a dead click
    if (room) {
      drilled.current = machineId;
      return;
    }
    if (drilled.current === machineId) {
      byHand.current.delete(machineId);
      return;
    }
    const here = city.machines.find((m) => m.id === machineId);
    if (!here) return; // its snapshot has not landed yet: there is nothing to drill into
    drilled.current = machineId;
    if (byHand.current.delete(machineId)) return; // arrived by hand: leave the choice alone
    const withDesks = here.floor.rooms.filter((r) => r.desks.length > 0);
    if (withDesks.length === 1) go(machineId, withDesks[0].id, true);
  }, [loading, machineId, room, machines, city, go]);

  useEffect(() => {
    if (!host) return;
    setFailed(false);
    const scene = new OfficeScene({
      onPickDesk: (tabId, projectId) => handlers.current.onPickDesk(tabId, projectId),
      onPickRoom: (id, roomId) => handlers.current.onPickRoom(id, roomId),
      onPickMachine: (id) => handlers.current.onPickMachine(id),
      onPickSign: (id) => handlers.current.onPickSign(id),
      onGoUp: () => handlers.current.onGoUp(),
    });
    sceneRef.current = scene;
    // setModel/focus are safe to call before mount() resolves — the scene stores them and
    // replays them once it can draw, so a scene created here is never left blank
    scene.setModel(cityRef.current);
    scene.focus(targetRef.current, true);
    // Pixi falls back from WebGL to canvas by itself; this only fires when neither could start
    scene.mount(host).catch(() => setFailed(true));
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [host]);

  // Esc walks up the ladder, F toggles focus mode. Subscribed once: what the keys do is read
  // through the same ref the scene's handlers use, so no move re-subscribes this listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // a dialog already handled it — don't also kick out of the room
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key === 'Escape') handlers.current.onEscape();
      else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) handlers.current.toggleFocus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!can('projects', 'read') || !can('terminals', 'read')) return <Navigate to="/" replace />;
  if (loading) return <Message>Carregando…</Message>;
  if (machines.length === 0) {
    return (
      <Message>
        Nenhuma máquina cadastrada ainda. <Link className="text-accent hover:underline" to="/">Cadastre a primeira</Link> para ver o escritório.
      </Message>
    );
  }
  if (machineId && !machines.some((m) => m.id === machineId)) return <Navigate to="/office" replace />;

  // the machine the camera is standing at, as the city drew it: null in the city, and null while a
  // machine's first snapshot is still on its way (there is nothing true to say about it yet)
  const here = machineId ? (city.machines.find((m) => m.id === machineId) ?? null) : null;
  const trail: Array<{ label: string; go?: () => void }> = [];
  if (machines.length > 1) trail.push({ label: 'Cidade', go: () => go(null, null, true) });
  const machineName = machines.find((m) => m.id === machineId)?.name;
  if (machineId && machineName) trail.push({ label: machineName, go: () => go(machineId, null, true) });
  const roomName = here?.floor.rooms.find((r) => r.id === room)?.name;
  if (roomName) trail.push({ label: roomName });
  const shareResult = shareResultFor(target, user?.id, user?.nickname ?? null, publicCityUrl, machines, byMachine);

  return (
    <div className="flex h-full flex-col">
      {!focus && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-bg-2 px-3 py-2 text-xs text-fg-muted">
          <span className="text-sm font-semibold text-fg">Escritório</span>
          <Trail parts={trail} />
          <span className="ml-auto flex items-center gap-3">
            <StatusNotices machine={here} connected={connected} />
            <ShareButton result={shareResult} />
            <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setFocus(true)} title="Modo foco (F)">
              modo foco
            </button>
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {/* an offline machine is dimmed by the scene now — its whole block is drawn dark — so the
            canvas must not be dimmed a second time on top of it, which left the floor unreadable */}
        <div ref={setHost} className="absolute inset-0 overflow-hidden" />
        {focus && (
          <div className="absolute right-3 top-3 flex items-center gap-3 rounded bg-bg-2/80 px-2 py-1 text-xs text-fg-muted">
            <StatusNotices machine={here} connected={connected} />
            <ShareButton result={shareResult} />
            <button className="rounded hover:text-fg" onClick={() => setFocus(false)}>
              sair do foco (Esc)
            </button>
          </div>
        )}
        {failed && <Overlay>Seu navegador não conseguiu desenhar o escritório.</Overlay>}
        {city.machines.length === 0 && <Overlay>Carregando a cidade…</Overlay>}
        {/* at its own rest a machine's block carries no words: its sign is the one thing hidden
            there (scene/detail.ts), so a failed read would otherwise be an empty outlined diamond
            and, on a single-machine account, the whole page */}
        {here?.notice === 'error' && <Overlay>Não foi possível carregar o escritório desta máquina.</Overlay>}
        {here && here.notice !== 'error' && here.floor.rooms.length === 0 && <Overlay>Esta máquina ainda não tem projetos.</Overlay>}
      </div>
    </div>
  );
}

/**
 * Where the camera stands, as the ladder Esc walks: Cidade › máquina › projeto. Every part but the
 * last one goes to that rest, replacing rather than pushing (going up must not pile history up).
 * With a single machine there is no city to go back to, so that part is not rendered at all.
 */
function Trail({ parts }: { parts: Array<{ label: string; go?: () => void }> }) {
  return (
    <nav aria-label="Trilha" className="flex items-center gap-1">
      {parts.map((part, i) => (
        <span key={`${i}:${part.label}`} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-fg-muted/60">
              ›
            </span>
          )}
          {i === parts.length - 1 ? (
            <span className="text-fg">{part.label}</span>
          ) : (
            <button className="rounded px-1 py-0.5 hover:bg-bg-3 hover:text-fg" onClick={part.go}>
              {part.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * Why the scene may not be telling the truth right now. Rendered in the top bar and, in focus mode
 * (where there is no top bar), in the corner: a second monitor left open all day must never show a
 * frozen picture that looks live. One machine's own trouble is only said at its rest — in the city
 * its block is dark and its sign carries the notice.
 */
function StatusNotices({ machine, connected }: { machine: MachineModel | null; connected: boolean }) {
  return (
    <>
      {machine?.notice === 'offline' && <span className="text-warn">máquina offline</span>}
      {machine?.notice === 'silent' && <span className="text-warn">sem resposta do tmux: estado pode estar desatualizado</span>}
      {!connected && <span className="text-warn">reconectando…</span>}
    </>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-muted">{children}</div>;
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{children}</div>;
}

/** True once any room on that machine's last snapshot has a published project. */
function hasPublished(state: MachineSnapshotState | undefined): boolean {
  return !!state?.snapshot?.rooms.some((r) => r.project.is_public);
}

/**
 * `unpublished`: nothing in view has been made public (or the viewer has no nickname yet, which can
 * only be true before anything of theirs was ever published). `foreign`: something IS published
 * here, but on a machine this viewer does not own (view-as/view-all only) — there is no link this
 * viewer's own nickname could build for it.
 */
type ShareResult = { kind: 'link'; url: string } | { kind: 'unpublished' } | { kind: 'foreign' };

/**
 * The public city a nickname points to is that nickname's OWNER's city, filtered to their own
 * machines — never the signed-in viewer's. The two only agree while someone looks at their own
 * machines; under the existing view-as/view-all admin scope `machines` can carry other people's rows
 * (or an orphan's, `owner_id: null`), and building the link from the viewer's own nickname would then
 * point at a city that does not contain that machine, or at nothing at all. `Machine.owner_id` is
 * already on the payload — no new field carried for this — so a machine the signed-in user does not
 * own is caught here rather than trusted with a link that cannot work.
 */
function shareResultFor(
  target: FocusTarget,
  userId: string | undefined,
  nickname: string | null,
  publicCityUrl: string | null,
  machines: Machine[],
  byMachine: Record<string, MachineSnapshotState>,
): ShareResult {
  const owned = (m: Machine) => !!userId && m.owner_id === userId;
  // this instance's own address for public cities, as the server tells it — never a hardcoded host,
  // which on a self-hosted instance would hand out a link to somebody else's city
  const base = nickname && publicCityUrl ? `${publicCityUrl}/@${encodeURIComponent(nickname)}` : null;

  if (target.kind === 'city') {
    const ownMachines = machines.filter(owned);
    if (base && ownMachines.some((m) => hasPublished(byMachine[m.id]))) return { kind: 'link', url: base };
    if (machines.some((m) => !owned(m) && hasPublished(byMachine[m.id]))) return { kind: 'foreign' };
    return { kind: 'unpublished' };
  }

  const machine = machines.find((m) => m.id === target.machineId);
  if (!machine) return { kind: 'unpublished' };
  if (!owned(machine)) return hasPublished(byMachine[machine.id]) ? { kind: 'foreign' } : { kind: 'unpublished' };
  if (!base) return { kind: 'unpublished' };

  const state = byMachine[machine.id];
  if (target.kind === 'machine') return hasPublished(state) ? { kind: 'link', url: `${base}/${encodeURIComponent(machine.public_id)}` } : { kind: 'unpublished' };

  const room = state?.snapshot?.rooms.find((r) => r.project.id === target.roomId);
  if (!room?.project.is_public) return { kind: 'unpublished' };
  return { kind: 'link', url: `${base}/${encodeURIComponent(machine.public_id)}?room=${encodeURIComponent(room.project.public_id)}` };
}

type ShareStatus = 'idle' | 'copied' | 'failed';

/**
 * Copies the current rest's public link. When there is nothing to copy, the button explains why
 * instead of pretending there is something to copy — either nothing published yet, or (view-as/
 * view-all) something published that belongs to a city this viewer's own nickname cannot address.
 */
function ShareButton({ result }: { result: ShareResult }) {
  const [status, setStatus] = useState<ShareStatus>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const id = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(id);
  }, [status]);

  if (result.kind === 'unpublished') {
    return (
      <span className="rounded px-2 py-1 text-fg-dim" title="Publique um projeto para gerar o link público">
        nada publicado aqui ainda
      </span>
    );
  }
  if (result.kind === 'foreign') {
    return (
      <span className="rounded px-2 py-1 text-fg-dim" title="Só o dono de uma máquina pode compartilhar o link da cidade dela">
        pertence a outra pessoa
      </span>
    );
  }

  const link = result.url;
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(link);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };

  return (
    <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => void copy()} title={link}>
      {status === 'copied' ? 'link copiado' : status === 'failed' ? 'selecione e copie' : 'compartilhar'}
    </button>
  );
}
