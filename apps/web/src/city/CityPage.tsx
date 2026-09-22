import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCityModel, resolveFocus, sameFocus, type CityModel, type FocusTarget } from '../office/model';
import { OfficeScene } from '../office/scene/OfficeScene';
import type { PublicCity } from '../lib/types';
import { fetchCity, openCitySocket, toMachineEntries, type RobotFrame } from './api';
import { cityPath, restFromUrl, type Rest } from './url';

/** Where the landing takes someone who wants a city of their own. */
const WAITLIST_URL = 'https://termhub.dev/#waitlist';

/** A snapshot that could not be read is tried again, backing off the same way the socket does. */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

const readRest = (): Rest => restFromUrl(location.pathname, location.search);

/**
 * One socket frame, applied where it lands. The ids in it are the snapshot's own, so a change never
 * costs a second read of the city; a frame for a building or a room this page has never seen is
 * dropped, since there is nowhere to draw it.
 */
function applyRobot(city: PublicCity | null, frame: RobotFrame): PublicCity | null {
  if (!city) return city;
  let landed = false;
  const buildings = city.buildings.map((building) => {
    if (building.id !== frame.building) return building;
    const rooms = building.rooms.map((room) => {
      if (room.id !== frame.room) return room;
      landed = true;
      const i = room.robots.findIndex((r) => r.id === frame.robot.id);
      const robots = room.robots.slice();
      // a tab opened while somebody is watching joins the room instead of waiting for a reload
      if (i === -1) robots.push(frame.robot);
      else robots[i] = frame.robot;
      return { ...room, robots };
    });
    return { ...building, rooms };
  });
  return landed ? { ...city, buildings } : city;
}

/**
 * The public city: somebody else's account as a city, live, to a visitor with no account at all.
 * Three rests, like the office — the city, one building, one room — and nothing else: no sidebar,
 * no actions, no terminal. The snapshot is read on arrival and every change after it comes down the
 * socket, so a visit costs one read while the channel holds; the snapshot is read again only when
 * that channel is hung up, which is how a city taken off the street disappears without a reload.
 */
export function CityPage({ nickname }: { nickname: string }) {
  const [city, setCity] = useState<PublicCity | null>(null);
  /** the server said there is no such city: a 404 is final, and nothing here knocks again after it */
  const [missing, setMissing] = useState(false);
  const [rest, setRest] = useState<Rest>(readRest);
  // a callback ref, not useRef: the host <div> is absent while the snapshot is on its way, and a
  // ref alone would never re-trigger the mount effect once it finally renders
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const sceneRef = useRef<OfficeScene | null>(null);

  const gone = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryIn = useRef(RETRY_MIN_MS);

  /**
   * One read of the snapshot: on mount, and again every time the socket is hung up — that is the
   * only way to tell a city taken off the street from a channel that merely dropped. A read that
   * could not be made at all keeps whatever is drawn and comes back, because "we could not read it"
   * is not "it is not there".
   */
  const load = useCallback(async () => {
    if (gone.current) return;
    try {
      const answer = await fetchCity(nickname);
      if (gone.current) return;
      retryIn.current = RETRY_MIN_MS;
      if (answer) setCity(answer);
      else setMissing(true);
    } catch {
      if (gone.current) return;
      retry.current = setTimeout(() => void load(), retryIn.current);
      retryIn.current = Math.min(retryIn.current * 2, RETRY_MAX_MS);
    }
  }, [nickname]);

  useEffect(() => {
    gone.current = false;
    void load();
    return () => {
      gone.current = true;
      if (retry.current) clearTimeout(retry.current);
    };
  }, [load]);

  useEffect(() => {
    // a city that is not there has no channel to watch, and the upgrade would be refused the same
    // 404 over and over: once the snapshot has said so, this page stops knocking for good
    if (missing) return;
    return openCitySocket(nickname, {
      onRobot: (frame) => setCity((prev) => applyRobot(prev, frame)),
      onClosed: () => void load(),
    });
  }, [nickname, missing, load]);

  useEffect(() => {
    const onPop = () => setRest(readRest());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const entries = useMemo(() => (city ? toMachineEntries(city) : []), [city]);
  // no monitor on the street: the socket already wrote every change into `city` above
  const model = useMemo(() => buildCityModel(entries, () => undefined), [entries]);

  // mirrors `model` for the scene-mount effect below: a scene created there must be seeded with
  // whatever is already known, not sit blank waiting for this effect to fire again
  const modelRef = useRef<CityModel>(model);
  useEffect(() => {
    modelRef.current = model;
    sceneRef.current?.setModel(model);
  }, [model]);

  // an unknown building, or a ?room= of another building, falls back on its own (office/model.ts)
  const target = resolveFocus(model, rest.building ?? undefined, rest.room);
  // the target is rebuilt on every render, so the scene is only told when it changed BY VALUE:
  // re-framing an equal target would undo a camera the visitor moved by hand
  const targetRef = useRef<FocusTarget>(target);
  useEffect(() => {
    if (sameFocus(target, targetRef.current)) return;
    targetRef.current = target;
    sceneRef.current?.focus(target);
  });

  const go = useCallback(
    (building: string | null, room: string | null, replace = false) => {
      history[replace ? 'replaceState' : 'pushState'](null, '', cityPath(nickname, { building, room }));
      setRest({ building, room });
    },
    [nickname],
  );

  /** The ladder Esc and the zoom-out gesture walk: room -> building -> city. Going up replaces, or Back would walk straight back in. */
  const up = () => {
    if (target.kind === 'room') go(target.machineId, null, true);
    else if (target.kind === 'machine') go(null, null, true);
  };

  // the scene and the key listener call through this ref, re-synced after every render, which is
  // what lets the mount effect below depend on the host element ALONE
  const actions = {
    onPickRoom: (building: string, room: string) => go(building, room),
    onPickBuilding: (building: string) => go(building, null),
    onGoUp: () => up(),
  };
  const handlers = useRef(actions);
  useEffect(() => {
    handlers.current = actions;
  });

  useEffect(() => {
    if (!host) return;
    setFailed(false);
    const scene = new OfficeScene({
      // a desk and a room sign lead somewhere only for the person who owns them: on the street they
      // are scenery, and this bundle knows no route that could open one
      onPickDesk: () => {},
      onPickSign: () => {},
      onPickRoom: (building, room) => handlers.current.onPickRoom(building, room),
      onPickMachine: (building) => handlers.current.onPickBuilding(building),
      onGoUp: () => handlers.current.onGoUp(),
    });
    sceneRef.current = scene;
    // setModel/focus are safe to call before mount() resolves — the scene replays them once it can draw
    scene.setModel(modelRef.current);
    scene.focus(targetRef.current, true);
    // Pixi falls back from WebGL to canvas by itself; this only fires when neither could start
    scene.mount(host).catch(() => setFailed(true));
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handlers.current.onGoUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (missing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-fg-muted">Cidade não encontrada.</p>
        <CreateAccount />
      </div>
    );
  }

  const here = rest.building ? (model.machines.find((m) => m.id === rest.building) ?? null) : null;
  const trail: Array<{ label: string; go?: () => void }> = [];
  if (rest.building) trail.push({ label: 'Cidade', go: () => go(null, null, true) });
  if (here) trail.push({ label: here.name, go: () => go(here.id, null, true) });
  const roomName = here?.floor.rooms.find((r) => r.id === rest.room)?.name;
  if (roomName) trail.push({ label: roomName });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-bg-2 px-3 py-2 text-xs text-fg-muted">
        <span className="text-sm font-semibold text-fg">Cidade de {city?.owner_name ?? '…'}</span>
        <Trail parts={trail} />
        <span className="ml-auto">
          <CreateAccount />
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={setHost} className="absolute inset-0 overflow-hidden" />
        {failed && <Overlay>Seu navegador não conseguiu desenhar a cidade.</Overlay>}
        {!failed && model.machines.length === 0 && <Overlay>Carregando a cidade…</Overlay>}
      </div>
    </div>
  );
}

function CreateAccount() {
  return (
    <a className="inline-flex items-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover" href={WAITLIST_URL}>
      Criar minha conta
    </a>
  );
}

/** Where the camera stands, as the ladder Esc walks: Cidade › prédio › sala. */
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

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{children}</div>;
}
