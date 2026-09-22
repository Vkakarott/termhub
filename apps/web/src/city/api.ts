/**
 * Everything the public city says to the server, and the only thing in this bundle that talks to it:
 * a plain fetch and a plain socket, no session, no credentials, nothing shared with the app's api
 * client. Both surfaces are open to anyone with the link (apps/server/src/routes/public-city.ts).
 */
import type { MachineEntry } from '../office/model';
import type { PublicCity, PublicRobot } from '../lib/types';

/** One change of one published room, as /ws/public sends it. `building`/`room` are snapshot ids: they join. */
export interface RobotFrame {
  type: 'robot';
  building: string;
  room: string;
  robot: PublicRobot;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The snapshot, or null when there is no such city. A nickname nobody took and one whose owner
 * published nothing answer the same 404 on purpose, so there is nothing here to tell apart — but
 * "we could not read it right now" is a different answer and throws instead, because drawing it as
 * "this city does not exist" would be a lie the visitor could not get out of. `credentials: 'omit'`
 * so that nothing of a visitor who happens to have a session is ever attached to a public read.
 */
export async function fetchCity(nickname: string): Promise<PublicCity | null> {
  const r = await fetch(`/api/public/city/${encodeURIComponent(nickname)}`, { credentials: 'omit' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`public city: ${r.status}`);
  return (await r.json()) as PublicCity;
}

/**
 * The live channel, reconnecting on close with a backoff that doubles up to 30 s. `onClosed` fires
 * on every close the page did not ask for: the server hangs this socket up when the last published
 * room is taken off the street, and a reconnect refused at the upgrade looks exactly the same from
 * here — only a fresh read of the snapshot can tell the two apart, so that is the caller's job.
 * Returns the close.
 */
export function openCitySocket(nickname: string, handlers: { onRobot: (frame: RobotFrame) => void; onClosed: () => void }): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wait = RECONNECT_MIN_MS;
  let stopped = false;
  const open = () => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/public/${encodeURIComponent(nickname)}`);
    ws.onopen = () => {
      wait = RECONNECT_MIN_MS;
    };
    ws.onmessage = (ev) => {
      let frame: RobotFrame;
      try {
        frame = JSON.parse(String(ev.data)) as RobotFrame;
      } catch {
        return;
      }
      if (frame?.type === 'robot' && frame.robot) handlers.onRobot(frame);
    };
    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      timer = setTimeout(open, wait);
      wait = Math.min(wait * 2, RECONNECT_MAX_MS);
      handlers.onClosed();
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

/**
 * The public payload as the office model's input, and the one adaptation the street needs: the
 * server mirrors the office snapshot's field names (apps/server/src/public/city.ts), so from here on
 * the model, the scene, the overlay and the activity label are the very code the app runs.
 */
export function toMachineEntries(city: PublicCity): MachineEntry[] {
  return city.buildings.map((building) => ({
    id: building.id,
    name: building.name,
    // a visitor is never told a machine is offline: the city they were given a link to is the one
    // that was published, drawn lit, and each robot's own `alive` already says who is at a desk
    online: true,
    failed: false,
    snapshot: {
      machine: { id: building.id },
      // the server read the tmux memo before answering and never asks a machine on a visitor's
      // behalf, so there is no "could not reach it" for this page to draw
      reachable: true,
      rooms: building.rooms.map((room) => ({
        project: { id: room.id, name: room.name, status: 'active' as const },
        // the board is not published: a room sign on the street carries a name, never a task count
        tasks: null,
        tabs: room.robots.map((robot, i) => ({
          id: robot.id,
          project_id: room.id,
          name: robot.name,
          kind: robot.kind,
          // the payload keeps the server's order and nothing else orders the desks
          position: i,
          state: robot.state,
          // the tool's own message and the tool's name are not published
          state_text: null,
          state_tool: null,
          state_at: robot.state_at,
          // whether the owner has looked is the owner's business: on the street a raised hand stays raised
          state_seen_at: null,
          activity: robot.activity,
          alive: robot.alive,
          progress: robot.progress,
        })),
      })),
    },
  }));
}
