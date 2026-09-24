import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { cachedTmuxProbe, type TmuxProbe } from '../terminal/machine-exec.js';
import { toPublicCity, type PublicCity } from './city.js';
import { publicBus } from './bus.js';
import { effectiveShortUrl } from './short-link.js';

/**
 * The one read behind both public surfaces: a nickname, and only the projects its owner published
 * (see `resolvePublicCity`), each one a building. This never initiates an ssh round-trip: it only
 * ever *reads* the tmux memo the office already warms (`cachedTmuxProbe`), and never calls the
 * probing function that would refresh it. When the memo is warm, a terminal tab's `alive` is real
 * tmux session membership. When it is cold — nobody with the office open recently, or the memo
 * expired — the tab's own last reported state stands in for it instead (a tab that never reported
 * one reads as not alive): an anonymous visitor must not be able to make this server dial an
 * unreachable machine and wait out its timeout, and a cold city showing every desk empty would be a
 * worse answer than a stale one.
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
 * What a person's city is made of (city-by-project §2.4): their published, non-archived projects
 * (by name) — each one a building, even with no agent at all — and the machines THEY own, the only
 * ones whose tabs may be shown. A tab of a published project on a machine somebody else owns is
 * never a robot: its name is not the owner's to publish. Both lists are empty when nothing is
 * published, and the machines are not even read then.
 */
export async function resolvePublicCity(repos: Pick<Repositories, 'machines' | 'projects'>, ownerId: string): Promise<{ projects: Project[]; machines: Machine[] }> {
  // An empty id must never reach `projects.list`, where a falsy owner could read as "no filter".
  if (!ownerId) return { projects: [], machines: [] };
  // `projects.list({ owner })` already filters by owner; checked again here because this is the line
  // that decides whose work goes on the street.
  const projects = (await repos.projects.list({ owner: ownerId })).filter((p) => p.owner_id === ownerId && p.is_public && p.status !== 'archived');
  if (projects.length === 0) return { projects: [], machines: [] };
  // machines.list(ownerId) already filters by owner; checked again because this is the one line
  // standing between a published project and somebody else's machine
  const machines = (await repos.machines.list(ownerId)).filter((m) => m.owner_id === ownerId);
  return { projects, machines };
}

export async function readPublicCity(repos: Repositories, nickname: string): Promise<PublicCity | undefined> {
  const owner = await repos.users.findByNickname(nickname);
  if (!owner) return undefined;
  const { projects, machines } = await resolvePublicCity(repos, owner.id);
  if (projects.length === 0) return undefined;
  const owned = new Set(machines.map((m) => m.id));
  // one read for every building, then only what runs on a machine the owner owns
  const tabs = (await repos.tabs.listByProjects(projects.map((p) => p.id))).filter((t) => owned.has(t.machine_id));
  const probes = new Map<string, TmuxProbe | undefined>();
  const probeOf = (machineId: string): TmuxProbe | undefined => {
    if (!probes.has(machineId)) probes.set(machineId, cachedTmuxProbe(machineId));
    return probes.get(machineId);
  };
  const buildings = projects.map((project) => ({
    project,
    robots: tabs
      .filter((t) => t.project_id === project.id)
      .map((tab) => ({ tab, alive: publicAlive(tab, tab.kind === 'terminal' ? probeOf(tab.machine_id) : undefined), progress: null })),
  }));
  // A saved link keeps showing even if the key is removed later: it still works; the key gates creation and editing only.
  return toPublicCity({ nickname, ownerName: owner.name, shortUrl: effectiveShortUrl(owner), buildings });
}

/** How long one read of a city answers every anonymous surface that asks for it again. */
export const PUBLIC_CITY_MEMO_MS = 4_000;
/** A memory bound, not a hit-rate tool: random nicknames from a stranger evict, they never grow it. */
export const PUBLIC_CITY_MEMO_MAX = 500;

const cityMemo = new Map<string, { at: number; city: Promise<PublicCity | undefined> }>();

// A publish, an unpublish, an archive, an unarchive or a deletion drops every memoised city at once: those are
// rare, and an unpublished room must be gone for the very next read, not a few seconds later.
publicBus.subscribe(() => cityMemo.clear());
// Robots leaving the street (a machine reassigned or deleted, a project unlinked), likewise.
publicBus.subscribeRobotsGone(() => cityMemo.clear());
// A deleted owner (their nickname, and so their whole city), likewise.
publicBus.subscribeOwnerGone(() => cityMemo.clear());
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
 * this, each of those was a full read (four queries), with nothing in front of it.
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
