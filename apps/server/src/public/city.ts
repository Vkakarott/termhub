import { publicId, publicRoomId } from './public-id.js';
import type { Machine, OfficeTabProgress, Project, Tab, TabActivity, TabState } from '../db/repositories/types.js';

/**
 * The public face of the office, and the only thing that reaches a visitor. Every field here was
 * written on purpose: nothing is spread, so a column added to Tab, Project or Machine tomorrow
 * stays inside the instance until somebody adds it here too.
 */
export interface PublicRobot {
  id: string;
  name: string;
  kind: Tab['kind'];
  state: TabState | null;
  state_at: string | null;
  activity: TabActivity | null;
  alive: boolean;
  progress: { done: number; total: number } | null;
}

/** A live change of one robot: `building`/`room` are the snapshot's own ids, so the page joins them. */
export interface PublicRobotFrame { type: 'robot'; building: string; room: string; robot: PublicRobot }

export interface PublicRoom { id: string; name: string; robots: PublicRobot[] }
export interface PublicBuilding { id: string; name: string; rooms: PublicRoom[] }
export interface PublicCity { nickname: string; owner_name: string; buildings: PublicBuilding[] }

export function toPublicRobot(tab: Tab, opts: { alive: boolean; progress: OfficeTabProgress | null }): PublicRobot {
  return {
    id: publicId('tab', tab.id),
    name: tab.name,
    kind: tab.kind,
    state: tab.state,
    state_at: tab.state_at,
    activity: tab.activity,
    alive: opts.alive,
    progress: opts.progress ? { done: opts.progress.done, total: opts.progress.total } : null,
  };
}

export function toPublicRobotFrame(input: { machineId: string; projectId: string; tab: Tab; alive: boolean; progress: OfficeTabProgress | null }): PublicRobotFrame {
  return {
    type: 'robot',
    building: publicId('machine', input.machineId),
    room: publicRoomId(input.projectId, input.machineId),
    robot: toPublicRobot(input.tab, { alive: input.alive, progress: input.progress }),
  };
}

/** A robot leaving its room (its tab was closed or deleted): public ids and nothing else. */
export interface PublicRobotGone { type: 'robot_gone'; building: string; room: string; robot: string }

export function toPublicRobotGone(input: { machineId: string; projectId: string; tabId: string }): PublicRobotGone {
  return { type: 'robot_gone', building: publicId('machine', input.machineId), room: publicRoomId(input.projectId, input.machineId), robot: publicId('tab', input.tabId) };
}

export function toPublicCity(input: {
  nickname: string;
  ownerName: string;
  buildings: { machine: Machine; rooms: { project: Project; tabs: { tab: Tab; alive: boolean; progress: OfficeTabProgress | null }[] }[] }[];
}): PublicCity {
  return {
    nickname: input.nickname,
    owner_name: input.ownerName,
    buildings: input.buildings.map((b) => ({
      id: publicId('machine', b.machine.id),
      name: b.machine.name,
      rooms: b.rooms.map((r) => ({
        // one room per (project, building): a project linked to two machines has a room on each
        id: publicRoomId(r.project.id, b.machine.id),
        name: r.project.name,
        robots: r.tabs.map((t) => toPublicRobot(t.tab, { alive: t.alive, progress: t.progress })),
      })),
    })),
  };
}
