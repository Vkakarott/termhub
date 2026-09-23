import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { createUpgradeRouter } from '../ws/router.js';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type PublicUpgradeContext } from '../ws/router.js';
import { monitorBus } from '../monitor/bus.js';
import { publicBus } from './bus.js';
import { toPublicRobotFrame, toPublicRobotGone } from './city.js';
import { normalizeNickname } from './nickname.js';
import { publicAlive, resolvePublicRooms, roomKey } from './read.js';
import { cachedTmuxProbe } from '../terminal/machine-exec.js';

/**
 * `/ws/public/<nickname>`: the live city for a visitor with no account. It is not `/ws/monitor` with
 * a filter — a different channel, a different payload, and a set of public rooms (published project
 * × owned machine, see `resolvePublicRooms`) resolved at connect and kept current by `publicBus`, so
 * unpublishing, a machine changing owner or a project unlinked drops the socket instead of leaving
 * somebody watching a room that is no longer public.
 */
/** Every public socket this process holds at once, across all cities: past it, new visitors get a 503. */
export const PUBLIC_WS_MAX_SOCKETS = 1_000;
/** How often each public socket is pinged; one that has not answered the previous ping is dropped. */
export const PUBLIC_WS_HEARTBEAT_MS = 30_000;

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

  async function admit({ req, socket, head, params }: PublicUpgradeContext, release: () => void): Promise<void> {
    const reject = (status: number, text: string) => {
      release();
      rejectUpgrade(socket, status, text);
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
    const rooms = new Map<string, { projectId: string; machineId: string }>();
    for (const { machine, projects } of await resolvePublicRooms(deps.repos, owner.id)) {
      for (const project of projects) rooms.set(roomKey(project.id, machine.id), { projectId: project.id, machineId: machine.id });
    }
    if (rooms.size === 0) return reject(404, 'Not Found');
    // The visitor left while the lookups ran: nothing to upgrade (its `close` already released the slot).
    if (socket.destroyed) return release();

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      answered.set(ws, true);
      ws.on('pong', () => answered.set(ws, true));
      const offTab = monitorBus.subscribe((change) => {
        // both halves: the machine is this person's (a tab of their project on somebody else's
        // machine is never published) and the pair is one of the rooms this page was given
        if (change.owner_id !== owner.id || !rooms.has(roomKey(change.project_id, change.machine_id))) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        // A change proves the tab's tmux session existed once, not that it still does (a plain
        // "seen" click on the tab publishes here too): the same rule as the snapshot, reading the
        // same memo (never probing), so a visitor never sees the two public surfaces disagree.
        const probe = change.tab.kind === 'terminal' ? cachedTmuxProbe(change.machine_id) : undefined;
        const alive = publicAlive(change.tab, probe);
        ws.send(JSON.stringify(toPublicRobotFrame({ machineId: change.machine_id, projectId: change.project_id, tab: change.tab, alive, progress: null })));
      });
      /** Drops the rooms that match and hangs up if there were any: the page re-reads the snapshot. */
      const dropRooms = (match: (room: { projectId: string; machineId: string }) => boolean) => {
        let dropped = 0;
        for (const [key, room] of rooms) {
          if (!match(room)) continue;
          rooms.delete(key);
          dropped++;
        }
        if (dropped > 0) ws.close(1000, 'unpublished');
      };
      const offPublic = publicBus.subscribe((change) => {
        if (change.is_public) return;
        dropRooms((room) => room.projectId === change.project_id);
      });
      const offRooms = publicBus.subscribeRoomsGone((gone) => {
        dropRooms((room) => room.machineId === gone.machine_id && (gone.project_id === undefined || room.projectId === gone.project_id));
      });
      const offGone = publicBus.subscribeTabRemoved((removed) => {
        if (!rooms.has(roomKey(removed.project_id, removed.machine_id)) || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(toPublicRobotGone({ machineId: removed.machine_id, projectId: removed.project_id, tabId: removed.tab_id })));
      });
      const teardown = () => {
        offTab();
        offPublic();
        offRooms();
        offGone();
        release();
      };
      log.info({ nickname: parsed.value, rooms: rooms.size }, 'public visitor connected');
      ws.on('close', () => {
        teardown();
        log.info({ nickname: parsed.value, rooms: rooms.size }, 'public visitor disconnected');
      });
      // A server-side ws socket with no error listener throws on a protocol violation (e.g. a
      // frame over maxPayload) — uncaught, that takes the whole process down. This route is
      // unauthenticated on a vhost with no Cloudflare Access, so it gets no benefit of the doubt.
      ws.on('error', (err) => {
        teardown();
        log.warn({ nickname: parsed.value, err: err.message }, 'public visitor socket error');
      });
    });
  }

  return wss;
}
