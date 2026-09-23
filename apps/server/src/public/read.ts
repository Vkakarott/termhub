import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { cachedTmuxProbe, type TmuxProbe } from '../terminal/machine-exec.js';
import { toPublicCity, type PublicCity } from './city.js';
import { publicBus } from './bus.js';

/**
 * The one read behind both public surfaces: a nickname, the machines its owner has, and only the
 * projects that are published (see `resolvePublicRooms`). This never initiates an ssh round-trip: it only ever *reads* the
 * tmux memo the office already warms (`cachedTmuxProbe`), and never calls the probing function that
 * would refresh it. When the memo is warm, a terminal tab's `alive` is real tmux session membership.
 * When it is cold — nobody with the office open recently, or the memo expired — the tab's own last
 * reported state stands in for it instead (a tab that never reported one reads as not alive):
 * an anonymous visitor must not be able to make this server dial an unreachable machine and wait out
 * its timeout, and a cold city showing every desk empty would be a worse answer than a stale one.
 */
/**
 * Whether a robot sits at its desk, by the one rule both public surfaces use — the snapshot here and
 * every frame on `/ws/public` (public/ws.ts) — so a visitor never sees them disagree: with a warm
 * memo, real tmux session membership; with a cold one, the tab's own last reported state.
 */
export function publicAlive(tab: Pick<Tab, 'kind' | 'state' | 'tmux_session'>, probe: TmuxProbe | undefined): boolean {
  return probe ? probe.reachable && !!tab.tmux_session && probe.sessions.has(tab.tmux_session) : tab.kind === 'terminal' && tab.state !== null;
}

/**
 * What a person's city is made of (merge ruling 2): their published, non-archived projects, and the
 * machines THEY own that at least one of those projects is linked to. A room is one (published
 * project, owned machine) pair. A project linked to a machine somebody else owns never brings that
 * machine along — publishing one's project must not expose another person's machine — so such a
 * link simply has no room. Buildings keep the machines' own order; rooms keep the projects' (by name).
 */
export async function resolvePublicRooms(
  repos: Pick<Repositories, 'machines' | 'projects' | 'projectMachines'>,
  ownerId: string,
): Promise<Array<{ machine: Machine; projects: Project[] }>> {
  const projects = (await repos.projects.list({ owner: ownerId })).filter((p) => p.is_public && p.status !== 'archived');
  if (projects.length === 0) return [];
  const [machines, links] = await Promise.all([repos.machines.list(ownerId), repos.projectMachines.listByProjects(projects.map((p) => p.id))]);
  const buildings = [];
  for (const machine of machines) {
    // machines.list(ownerId) already filters by owner; checked again here because this is the one
    // line standing between a published project and somebody else's machine
    if (machine.owner_id !== ownerId) continue;
    const linked = new Set(links.filter((l) => l.machine_id === machine.id).map((l) => l.project_id));
    const rooms = projects.filter((p) => linked.has(p.id));
    if (rooms.length > 0) buildings.push({ machine, projects: rooms });
  }
  return buildings;
}

/** The key of one public room, as the live channel tracks it. */
export const roomKey = (projectId: string, machineId: string): string => `${projectId}:${machineId}`;

export async function readPublicCity(repos: Repositories, nickname: string): Promise<PublicCity | undefined> {
  const owner = await repos.users.findByNickname(nickname);
  if (!owner) return undefined;
  const resolved = await resolvePublicRooms(repos, owner.id);
  if (resolved.length === 0) return undefined;
  const buildings = [];
  for (const { machine, projects } of resolved) {
    // only the tabs that run on this machine: the same project's tabs on another machine are
    // another room (or, on a machine this person does not own, no room at all)
    const tabs = await repos.tabs.listByProjectsOnMachine(projects.map((p) => p.id), machine.id);
    const probe = tabs.some((t) => t.kind === 'terminal') ? cachedTmuxProbe(machine) : undefined;
    buildings.push({
      machine,
      rooms: projects.map((project) => ({
        project,
        tabs: tabs.filter((t) => t.project_id === project.id).map((tab) => ({
          tab,
          alive: publicAlive(tab, probe),
          progress: null,
        })),
      })),
    });
  }
  return toPublicCity({ nickname, ownerName: owner.name, buildings });
}

/** How long one read of a city answers every anonymous surface that asks for it again. */
export const PUBLIC_CITY_MEMO_MS = 4_000;
/** A memory bound, not a hit-rate tool: random nicknames from a stranger evict, they never grow it. */
export const PUBLIC_CITY_MEMO_MAX = 500;

const cityMemo = new Map<string, { at: number; city: Promise<PublicCity | undefined> }>();

// A publish, an unpublish, an archive or a deletion drops every memoised city at once: those are
// rare, and an unpublished room must be gone for the very next read, not a few seconds later.
publicBus.subscribe(() => cityMemo.clear());
// A building or a room leaving the street (owner reassigned, machine deleted, project unlinked), likewise.
publicBus.subscribeRoomsGone(() => cityMemo.clear());
// A closed tab, likewise: a reload right after must not bring its robot back for a few seconds.
publicBus.subscribeTabRemoved(() => cityMemo.clear());

/** Tests only. */
export function clearPublicCityMemo(): void {
  cityMemo.clear();
}

/**
 * `readPublicCity` behind a short in-process memo, keyed by the normalized nickname: what every
 * anonymous surface calls (the snapshot, the `/city/*` document and the link-preview card). A link
 * click costs the document plus the snapshot, and an unfurl the document plus the card — without
 * this, each of those was a full read (2 + 2N queries for N machines), with nothing in front of it.
 * Concurrent callers share one in-flight read; a failed read is never kept.
 */
export function readPublicCityCached(repos: Repositories, nickname: string, opts: { now?: () => number } = {}): Promise<PublicCity | undefined> {
  const now = (opts.now ?? Date.now)();
  const hit = cityMemo.get(nickname);
  if (hit && now - hit.at < PUBLIC_CITY_MEMO_MS) return hit.city;
  if (hit) cityMemo.delete(nickname);
  for (const [key, entry] of cityMemo) {
    if (now - entry.at >= PUBLIC_CITY_MEMO_MS) cityMemo.delete(key);
  }
  if (cityMemo.size >= PUBLIC_CITY_MEMO_MAX) {
    // Map iterates in insertion order: the first key is the oldest surviving entry.
    const oldest = cityMemo.keys().next().value;
    if (oldest !== undefined) cityMemo.delete(oldest);
  }
  const city = readPublicCity(repos, nickname);
  const entry = { at: now, city };
  cityMemo.set(nickname, entry);
  city.catch(() => {
    if (cityMemo.get(nickname) === entry) cityMemo.delete(nickname);
  });
  return city;
}
