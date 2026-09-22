/**
 * Snapshot + live monitor state -> what the scene draws. Pure, and the only place where a tab's
 * fields are turned into poses and markers: the scene never reads a `Tab`.
 */
import { tabNeedsYou } from '../lib/needs-you';
import type { OfficeSnapshot, OfficeTab, Tab, TabActivity, TabState } from '../lib/types';

export type Pose = 'type' | 'raise' | 'sleep' | 'shake' | 'sit' | 'empty';
export type Marker = 'input' | 'permission' | 'error' | null;

export interface DeskModel {
  id: string;
  projectId: string;
  /** full tab name (hover) */
  name: string;
  /** what is drawn under the desk */
  label: string;
  kind: 'person' | 'phone';
  pose: Pose;
  marker: Marker;
  /** never reported a state: a person, but not an "idle" one */
  dimmed: boolean;
  screenOn: boolean;
  state: TabState | null;
  /** what the tool is about to do, under the person while typing; null off `working` or an old agent */
  activity: TabActivity | null;
  /** total = 0: a bound task with no subtasks — a title, no bar */
  progress: { done: number; total: number; title: string } | null;
  /** stable appearance variant, from the tab id */
  look: number;
}

export interface RoomModel {
  id: string;
  name: string;
  label: string;
  /** false for a paused project */
  lit: boolean;
  needsYou: number;
  progress: { done: number; total: number } | null;
  desks: DeskModel[];
}

export interface FloorModel {
  rooms: RoomModel[];
  needsYou: number;
}

export const LOOK_VARIANTS = 6;
const DESK_LABEL_MAX = 18;
const ROOM_LABEL_MAX = 28;

const POSE: Record<TabState, Pose> = { working: 'type', waiting_input: 'raise', waiting_permission: 'raise', idle: 'sleep', error: 'shake' };

const ACTIVITY_LABEL: Record<TabActivity, string> = { coding: 'codando', reading: 'lendo arquivos', researching: 'pesquisando', planning: 'planejando', terminal: 'no terminal', working: 'trabalhando' };
/** What a working person is doing, under them on the floor — pt-BR, or null when nothing is known. */
export function activityLabel(activity: TabActivity | null): string | null {
  return activity ? ACTIVITY_LABEL[activity] : null;
}

/** Collapses whitespace and cuts by code point (never inside an emoji), ending in an ellipsis. */
export function truncateLabel(text: string, max: number): string {
  const chars = Array.from(text.trim().replace(/\s+/g, ' '));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** FNV-1a over the id: the same tab is always the same person. */
export function lookOf(id: string, variants: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0) % variants;
}

const time = (iso: string | null): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Which side's state fields to draw. The monitor is normally ahead of the snapshot, but with the
 * WebSocket down its items go stale (it resyncs every 3 min) while a 60 s snapshot read keeps
 * coming — so the newer `state_at` wins, and on a tie only a fresher `state_seen_at` (the hand was
 * lowered elsewhere) moves the tab.
 */
function withLiveState(tab: OfficeTab, live: Tab | undefined): OfficeTab {
  if (!live) return tab;
  const fromLive = (): OfficeTab => ({ ...tab, state: live.state, state_text: live.state_text, state_tool: live.state_tool, state_at: live.state_at, state_seen_at: live.state_seen_at, activity: live.activity });
  const liveAt = time(live.state_at);
  const tabAt = time(tab.state_at);
  if (liveAt !== tabAt) return (liveAt ?? -Infinity) > (tabAt ?? -Infinity) ? fromLive() : tab;
  return (time(live.state_seen_at) ?? -Infinity) > (time(tab.state_seen_at) ?? -Infinity) ? fromLive() : tab;
}

/** `reachable`: false = the machine could not be asked which tmux sessions exist (see below). */
function deskOf(tab: OfficeTab, live: Tab | undefined, reachable: boolean): DeskModel {
  const t = withLiveState(tab, live);
  const base = { id: t.id, projectId: t.project_id, name: t.name, label: truncateLabel(t.name, DESK_LABEL_MAX), look: lookOf(t.id, LOOK_VARIANTS), progress: t.progress ? { done: t.progress.done, total: t.progress.total, title: t.progress.title } : null };
  // a simulator's `alive` comes from the simulator manager, so tmux being unreachable says nothing about it
  if (t.kind === 'simulator') return { ...base, kind: 'phone', pose: 'empty', marker: null, dimmed: false, screenOn: t.alive, state: null, activity: null };
  // an unreachable machine answers `alive: false` for every terminal tab, which is not evidence that
  // anyone left: keep the last known state (and its raised hand); the page's banner says it is stale
  if (!t.alive && reachable) return { ...base, kind: 'person', pose: 'empty', marker: null, dimmed: false, screenOn: false, state: t.state, activity: null };
  const needs = tabNeedsYou(t);
  const marker: Marker = t.state === 'error' ? 'error' : !needs ? null : t.state === 'waiting_permission' ? 'permission' : 'input';
  return { ...base, kind: 'person', pose: t.state ? POSE[t.state] : 'sit', marker, dimmed: !t.state, screenOn: t.state === 'working', state: t.state, activity: t.state === 'working' ? t.activity : null };
}

export function buildModel(snapshot: OfficeSnapshot, liveTab: (tabId: string) => Tab | undefined): FloorModel {
  const rooms = snapshot.rooms.map((r): RoomModel => {
    const desks = [...r.tabs].sort((a, b) => a.position - b.position).map((t) => deskOf(t, liveTab(t.id), snapshot.reachable));
    const total = r.tasks ? r.tasks.todo + r.tasks.doing + r.tasks.done : 0;
    return {
      id: r.project.id,
      name: r.project.name,
      label: truncateLabel(r.project.name, ROOM_LABEL_MAX),
      lit: r.project.status !== 'paused',
      needsYou: desks.filter((d) => d.marker === 'input' || d.marker === 'permission').length,
      progress: r.tasks && total > 0 ? { done: r.tasks.done, total } : null,
      desks,
    };
  });
  return { rooms, needsYou: rooms.reduce((n, r) => n + r.needsYou, 0) };
}

/** Ids of this machine's tabs that the monitor knows about and the snapshot doesn't yet: time to re-read it. */
export function missingTabIds(snapshot: OfficeSnapshot | null, monitorTabIds: string[], machineProjectIds: Set<string>, projectOf: (tabId: string) => string | undefined): string[] {
  if (!snapshot) return [];
  const known = new Set(snapshot.rooms.flatMap((r) => r.tabs.map((t) => t.id)));
  return monitorTabIds.filter((id) => !known.has(id) && machineProjectIds.has(projectOf(id) ?? ''));
}

/** What the page knows about one machine when it builds the city. */
export interface MachineEntry {
  id: string;
  name: string;
  /** false only when the status check said so; "still checking" counts as online */
  online: boolean;
  snapshot: OfficeSnapshot | null;
  /** the first read of this machine's snapshot failed */
  failed: boolean;
}

export type MachineNotice = 'offline' | 'silent' | 'error' | null;

export interface MachineModel {
  id: string;
  name: string;
  label: string;
  /** false for an offline machine: its block is drawn dark */
  lit: boolean;
  notice: MachineNotice;
  needsYou: number;
  floor: FloorModel;
}

export interface CityModel {
  machines: MachineModel[];
  needsYou: number;
}

const MACHINE_LABEL_MAX = 28;
const EMPTY_FLOOR: FloorModel = { rooms: [], needsYou: 0 };

/**
 * Every machine that has something to draw, in name order (the sidebar's): a loaded machine with
 * its floor, a failed one as an empty block. A machine still loading is left out — it joins when
 * its snapshot lands — and a snapshot for another machine counts as not loaded.
 */
export function buildCityModel(entries: MachineEntry[], liveTab: (tabId: string) => Tab | undefined): CityModel {
  const machines = entries
    .map((e): MachineModel | null => {
      const snapshot = e.snapshot && e.snapshot.machine.id === e.id ? e.snapshot : null;
      if (!snapshot && !e.failed) return null;
      const floor = snapshot ? buildModel(snapshot, liveTab) : EMPTY_FLOOR;
      const notice: MachineNotice = !snapshot ? 'error' : !e.online ? 'offline' : !snapshot.reachable ? 'silent' : null;
      return { id: e.id, name: e.name, label: truncateLabel(e.name, MACHINE_LABEL_MAX), lit: e.online, notice, needsYou: floor.needsYou, floor };
    })
    .filter((m): m is MachineModel => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { machines, needsYou: machines.reduce((n, m) => n + m.needsYou, 0) };
}

export type FocusTarget = { kind: 'city' } | { kind: 'machine'; machineId: string } | { kind: 'room'; machineId: string; roomId: string };

/** What the URL asks the camera to frame, against what actually exists: never a room of another machine. */
export function resolveFocus(city: CityModel | null, machineId: string | undefined, roomId: string | null): FocusTarget {
  const machine = city?.machines.find((m) => m.id === machineId);
  if (!machine) return { kind: 'city' };
  if (roomId && machine.floor.rooms.some((r) => r.id === roomId)) return { kind: 'room', machineId: machine.id, roomId };
  return { kind: 'machine', machineId: machine.id };
}

export function sameFocus(a: FocusTarget, b: FocusTarget): boolean {
  switch (a.kind) {
    case 'city':
      return b.kind === 'city';
    case 'machine':
      return b.kind === 'machine' && a.machineId === b.machineId;
    case 'room':
      return b.kind === 'room' && a.machineId === b.machineId && a.roomId === b.roomId;
  }
}
