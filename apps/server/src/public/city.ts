import { publicId } from './public-id.js';
import { publicSpinnerVerb } from './spinner-verbs.js';
import type { OfficeTabProgress, Project, Tab, TabActivity, TabState } from '../db/repositories/types.js';

/**
 * The public face of the office, and the only thing that reaches a visitor. Every field here was
 * written on purpose: nothing is spread, so a column added to Tab or Project tomorrow stays inside
 * the instance until somebody adds it here too. A building is a published project; nothing about a
 * machine — its id, its name, its subtitle — exists in this shape at all (city-by-project §2.3).
 */
export interface PublicRobot {
  id: string;
  name: string;
  kind: Tab['kind'];
  state: TabState | null;
  state_at: string | null;
  activity: TabActivity | null;
  /** Claude Code's spinner verb, only when it is one of its defaults (spinner-verbs.ts): a custom verb is the person's own words */
  activity_verb: string | null;
  alive: boolean;
  progress: { done: number; total: number } | null;
}

/** One published project on the street: its name and its agents on the owner's own machines. */
export interface PublicBuilding { id: string; name: string; robots: PublicRobot[] }
export interface PublicCity { nickname: string; owner_name: string; short_url: string | null; buildings: PublicBuilding[] }

/** A live change of one robot: `building` is the snapshot's own building id, so the page joins them. */
export interface PublicRobotFrame { type: 'robot'; building: string; robot: PublicRobot }

/** A robot leaving its building (its tab was closed or deleted): public ids and nothing else. */
export interface PublicRobotGone { type: 'robot_gone'; building: string; robot: string }

export function toPublicRobot(tab: Tab, opts: { alive: boolean; progress: OfficeTabProgress | null }): PublicRobot {
  // what the robot is doing only means something while it works: never publish a leftover
  const working = tab.state === 'working';
  return {
    id: publicId('tab', tab.id),
    name: tab.name,
    kind: tab.kind,
    state: tab.state,
    state_at: tab.state_at,
    activity: working ? tab.activity : null,
    activity_verb: working ? publicSpinnerVerb(tab.activity_verb) : null,
    alive: opts.alive,
    progress: opts.progress ? { done: opts.progress.done, total: opts.progress.total } : null,
  };
}

export function toPublicRobotFrame(input: { projectId: string; tab: Tab; alive: boolean; progress: OfficeTabProgress | null }): PublicRobotFrame {
  return { type: 'robot', building: publicId('project', input.projectId), robot: toPublicRobot(input.tab, { alive: input.alive, progress: input.progress }) };
}

export function toPublicRobotGone(input: { projectId: string; tabId: string }): PublicRobotGone {
  return { type: 'robot_gone', building: publicId('project', input.projectId), robot: publicId('tab', input.tabId) };
}

export function toPublicCity(input: {
  nickname: string;
  ownerName: string;
  shortUrl: string | null;
  buildings: { project: Project; robots: { tab: Tab; alive: boolean; progress: OfficeTabProgress | null }[] }[];
}): PublicCity {
  return {
    nickname: input.nickname,
    owner_name: input.ownerName,
    // the owner's effective short link (custom ?? partner): printed on share images, public by nature
    short_url: input.shortUrl,
    buildings: input.buildings.map((b) => ({
      id: publicId('project', b.project.id),
      name: b.project.name,
      robots: b.robots.map((r) => toPublicRobot(r.tab, { alive: r.alive, progress: r.progress })),
    })),
  };
}
