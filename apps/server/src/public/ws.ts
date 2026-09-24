import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type PublicUpgradeContext } from '../ws/router.js';
import { monitorBus } from '../monitor/bus.js';
import { publicBus } from './bus.js';
import { toPublicRobotFrame, toPublicRobotGone } from './city.js';
import { normalizeNickname } from './nickname.js';
import { publicAlive, resolvePublicCity } from './read.js';
import { cachedTmuxProbe } from '../terminal/machine-exec.js';

/**
 * `/ws/public/<nickname>`: the live city for a visitor with no account. It is not `/ws/monitor` with
 * a filter — a different channel, a different payload, and a city (the owner's published projects
 * and the machines they own, see `resolvePublicCity`) resolved at connect and kept current by
 * `publicBus`, so unpublishing, a machine changing owner or being deleted, a project unlinked or the
 * owner deleted drops the socket instead of leaving somebody watching what is no longer public.
 */
/** Every public socket this process holds at once, across all cities: past it, new visitors get a 503. */
export const PUBLIC_WS_MAX_SOCKETS = 1_000;
/** How often each public socket is pinged; one that has not answered the previous ping is dropped. */
export const PUBLIC_WS_HEARTBEAT_MS = 30_000;

/** How many times admission re-reads a city that changed under it before answering 503. */
export const PUBLIC_WS_ADMISSION_ATTEMPTS = 3;

/** What one socket may show: the owner's published projects (its buildings) and the machines they own (the only ones whose robots it sends). */
interface CityScope {
  published: Set<string>;
  owned: Set<string>;
}

/** A public-bus change that can take something off a socket: a project unpublished (or archived or deleted), robots leaving the street, the owner deleted. */
type PublicCityChange =
  | { kind: 'unpublished'; projectId: string }
  | { kind: 'robots-gone'; machineId: string; projectId?: string }
  | { kind: 'owner-gone'; ownerId: string };

/** Whether a change takes anything off this city: one of its buildings, or robots it could show. */
function touches(change: PublicCityChange, ownerId: string, city: CityScope): boolean {
  switch (change.kind) {
    case 'unpublished':
      return city.published.has(change.projectId);
    case 'robots-gone':
      return city.owned.has(change.machineId) && (change.projectId === undefined || city.published.has(change.projectId));
    case 'owner-gone':
      return change.ownerId === ownerId;
  }
}

/** Takes what a change touches off the sets the forwarding rule reads, so nothing more of it is ever sent. */
function drop(change: PublicCityChange, city: CityScope): void {
  switch (change.kind) {
    case 'unpublished':
      city.published.delete(change.projectId);
      return;
    case 'robots-gone':
      // a machine gone from this person (another owner, or deleted): none of its robots may be sent
      // again; an unlinked project's robots there were deleted with the link
      if (change.projectId === undefined) city.owned.delete(change.machineId);
      return;
    case 'owner-gone':
      city.published.clear();
      city.owned.clear();
  }
}

export function registerPublicWs(
  router: ReturnType<typeof createUpgradeRouter>,
  deps: { repos: Repositories; log: FastifyBaseLogger; limits?: { maxSockets?: number; heartbeatMs?: number } },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const log = deps.log.child({ mod: 'public-ws' });
  const maxSockets = deps.limits?.maxSockets ?? PUBLIC_WS_MAX_SOCKETS;

  // These sockets are anonymous, skip the Origin check (any page can open them from its visitors'
  // browsers) and sit behind a one-hour proxy read timeout: nginx's per-IP cap is the only other
  // bound. So the process keeps its own: a ceiling on how many it holds (counting upgrades still
  // resolving their nickname), and a ping per interval that drops a half-open socket which never
  // answered the last one, instead of letting it hold its bus listeners until the proxy gives up.
  let slots = 0;
  const answered = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (answered.get(ws) === false) {
        ws.terminate();
        continue;
      }
      answered.set(ws, false);
      ws.ping();
    }
  }, deps.limits?.heartbeatMs ?? PUBLIC_WS_HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  router.addPublic(/^\/ws\/public\/([^/]+)\/?$/, async (ctx) => {
    if (slots >= maxSockets) {
      log.warn({ slots }, 'public visitor refused: socket ceiling reached');
      return rejectUpgrade(ctx.socket, 503, 'Service Unavailable');
    }
    slots++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      slots--;
    };
    // The slot goes back with the socket, however it ends: a visitor who resets the connection
    // while the nickname lookups below are still pending, or a handshake `ws` aborts without ever
    // calling back. Attached here, where the slot is taken, not after the awaits — by then the
    // socket may already have closed and the listener would never fire. (The router gives every
    // upgrade socket an `error` listener, so a reset surfaces here as `close`.)
    ctx.socket.once('close', release);
    try {
      await admit(ctx, release);
    } catch (err) {
      release();
      throw err;
    }
  });

  async function admit(ctx: PublicUpgradeContext, release: () => void): Promise<void> {
    // The public bus is listened to from the very start of admission, not from the moment the socket
    // opens: the city is resolved across several awaits, and an unpublish, an archive, robots leaving
    // the street or the owner being deleted that lands during them would otherwise be missed for
    // good — the socket would then stream something that is already private. While admission runs,
    // changes are only recorded; once the socket is open, they are applied (see `live` below).
    const pending: PublicCityChange[] = [];
    let onChange: (change: PublicCityChange) => void = (change) => pending.push(change);
    const offs = [
      publicBus.subscribe((change) => {
        if (!change.is_public) onChange({ kind: 'unpublished', projectId: change.project_id });
      }),
      publicBus.subscribeRobotsGone((gone) => onChange({ kind: 'robots-gone', machineId: gone.machine_id, projectId: gone.project_id })),
      publicBus.subscribeOwnerGone((gone) => onChange({ kind: 'owner-gone', ownerId: gone.owner_id })),
    ];
    const unsubscribe = () => {
      for (const off of offs.splice(0)) off();
    };
    // However admission ends — refused, reset by the visitor, a handshake `ws` aborts without
    // calling back, or the open socket closing later — the listeners go with the socket.
    ctx.socket.once('close', unsubscribe);
    let upgrading = false;
    try {
      upgrading = await admitResolved(ctx, release, {
        takePending: () => pending.splice(0),
        goLive: (live) => {
          onChange = live;
          return unsubscribe;
        },
      });
    } finally {
      if (!upgrading) unsubscribe();
    }
  }

  async function admitResolved(
    { req, socket, head, params }: PublicUpgradeContext,
    release: () => void,
    changes: { takePending: () => PublicCityChange[]; goLive: (live: (change: PublicCityChange) => void) => () => void },
  ): Promise<boolean> {
    const reject = (status: number, text: string) => {
      release();
      rejectUpgrade(socket, status, text);
      return false;
    };
    // A malformed escape (`%`) makes decodeURIComponent throw; every rejected nickname answers
    // the same 404, not a 500 that would tell a stranger their input broke something.
    let raw: string;
    try {
      raw = decodeURIComponent(params[0] ?? '');
    } catch {
      return reject(404, 'Not Found');
    }
    const parsed = normalizeNickname(raw);
    if (!parsed.ok) return reject(404, 'Not Found');
    const owner = await deps.repos.users.findByNickname(parsed.value);
    if (!owner) return reject(404, 'Not Found');
    const resolveCity = async (): Promise<CityScope> => {
      const { projects, machines } = await resolvePublicCity(deps.repos, owner.id);
      return { published: new Set(projects.map((p) => p.id)), owned: new Set(machines.map((m) => m.id)) };
    };
    // A change recorded while the city was read may have landed after the read (the read is then
    // stale) or before it (harmless): only one that touches what the read returned forces a re-read.
    // Past a few attempts under a storm of changes, the visitor is told to come back.
    let city = await resolveCity();
    for (let attempt = 1; changes.takePending().some((change) => touches(change, owner.id, city)); attempt++) {
      if (attempt >= PUBLIC_WS_ADMISSION_ATTEMPTS) {
        log.warn({ nickname: parsed.value }, 'public visitor refused: the city kept changing during admission');
        return reject(503, 'Service Unavailable');
      }
      city = await resolveCity();
    }
    if (city.published.size === 0) return reject(404, 'Not Found');
    // The visitor left while the lookups ran: nothing to upgrade (its `close` already released the slot).
    if (socket.destroyed) {
      release();
      return false;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      answered.set(ws, true);
      ws.on('pong', () => answered.set(ws, true));
      const offTab = monitorBus.subscribe((change) => {
        // all three: the monitor names this person as the machine's owner, the project is one of
        // their published buildings, and the machine is one they own — a tab of their project on
        // somebody else's machine is never a robot
        if (change.owner_id !== owner.id || !city.published.has(change.project_id) || !city.owned.has(change.machine_id)) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        // A change proves the tab's tmux session existed once, not that it still does (a plain
        // "seen" click on the tab publishes here too): the same rule as the snapshot, reading the
        // same memo (never probing), so a visitor never sees the two public surfaces disagree.
        const probe = change.tab.kind === 'terminal' ? cachedTmuxProbe(change.machine_id) : undefined;
        const alive = publicAlive(change.tab, probe);
        ws.send(JSON.stringify(toPublicRobotFrame({ projectId: change.project_id, tab: change.tab, alive, progress: null })));
      });
      /**
       * Takes what a change touches off this city and hangs up: the page re-reads the snapshot, the
       * one place that can say which buildings and robots are still on the street — a frame never
       * names a machine, so the page could not drop a machine's robots by itself.
       */
      const live = (change: PublicCityChange) => {
        if (!touches(change, owner.id, city)) return;
        drop(change, city);
        ws.close(1000, change.kind === 'robots-gone' ? 'robots gone' : 'unpublished');
      };
      // Anything that landed between the last read and this callback is applied before going live.
      const early = changes.takePending();
      const offPublic = changes.goLive(live);
      for (const change of early) live(change);
      const offGone = publicBus.subscribeTabRemoved((removed) => {
        if (!city.published.has(removed.project_id) || !city.owned.has(removed.machine_id) || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(toPublicRobotGone({ projectId: removed.project_id, tabId: removed.tab_id })));
      });
      const teardown = () => {
        offTab();
        offPublic();
        offGone();
        release();
      };
      log.info({ nickname: parsed.value, buildings: city.published.size }, 'public visitor connected');
      ws.on('close', () => {
        teardown();
        log.info({ nickname: parsed.value, buildings: city.published.size }, 'public visitor disconnected');
      });
      // A server-side ws socket with no error listener throws on a protocol violation (e.g. a
      // frame over maxPayload) — uncaught, that takes the whole process down. This route is
      // unauthenticated on a vhost with no Cloudflare Access, so it gets no benefit of the doubt.
      ws.on('error', (err) => {
        teardown();
        log.warn({ nickname: parsed.value, err: err.message }, 'public visitor socket error');
      });
    });
    return true;
  }

  return wss;
}
