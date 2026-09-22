/** Dev tool: the office city with synthetic data, no login and no server — for screenshots and frame timing. */
import type { OfficeRoom, OfficeSnapshot, OfficeTab, TabActivity, TabState } from '../lib/types';
import { buildCityModel, type FocusTarget, type MachineEntry } from './model';
import { OfficeScene } from './scene/OfficeScene';

const STATES: Array<TabState | null> = ['working', 'working', 'working', 'waiting_input', 'waiting_permission', 'idle', 'idle', 'error', null];
const q = new URLSearchParams(location.search);
/** `-1` when absent: `Number(null)` is 0, which would silently mean "machine 0". */
const index = (name: string) => (q.get(name) === null ? -1 : Number(q.get(name)));
const machineCount = Number(q.get('machines')) || 3;
const roomCount = Number(q.get('rooms')) || 6;
const deskMax = Number(q.get('desks')) || 8;
const at = new Date().toISOString();

const ACTIVITIES: TabActivity[] = ['coding', 'reading', 'researching', 'planning', 'terminal', 'working'];
const activityParam = q.get('activity');
/** `?activity=<category>` puts that activity on every working desk; `?activity=mix` cycles through the six. */
function activityFor(i: number, state: TabState | null): TabActivity | null {
  if (state !== 'working' || !activityParam) return null;
  return activityParam === 'mix' ? ACTIVITIES[i % ACTIVITIES.length] : (activityParam as TabActivity);
}

/**
 * Machine 0 keeps v1's showcase floor: room 1 empty, room 2 with one desk per STATES entry — with
 * the simulator and the dead tab in there, that room shows every desk the scene can draw. The other
 * machines shift both counts, so no two blocks come out the same size.
 */
function roomsOf(mi: number): OfficeRoom[] {
  const n = Math.max(2, roomCount - (mi % 3));
  return Array.from({ length: n }, (_, r) => {
    const count = mi === 0 && r === 1 ? 0 : mi === 0 && r === 2 ? Math.max(STATES.length, deskMax) : 1 + ((r * 5 + mi * 3) % deskMax);
    const projectId = `m${mi}-p${r}`;
    const tabs = Array.from({ length: count }, (_, i): OfficeTab => {
      const state = STATES[(r + i + mi) % STATES.length];
      // i = 1 carries a task with no subtasks: no bar anywhere, its title only on hover
      const progress = i % 3 === 0 ? { task_id: 'k', title: 'Tarefa com subtarefas', done: i % 4, total: 4 } : i === 1 ? { task_id: 'k0', title: 'Tarefa sem subtarefas', done: 0, total: 0 } : null;
      return { id: `m${mi}-t${r}-${i}`, project_id: projectId, name: i === 0 ? 'um nome de aba bem comprido mesmo 🚀' : `aba ${i + 1}`, kind: i % 8 === 7 ? 'simulator' : 'terminal', tmux_session: null, simulator_udid: null, position: i, state, state_text: null, state_tool: null, state_at: state ? at : null, state_seen_at: null, activity: activityFor(i, state), created_at: at, alive: i % 9 !== 4, progress };
    });
    return {
      project: { id: projectId, machine_id: `m${mi}`, name: r === 0 ? 'projeto com um nome enorme para testar o corte' : `projeto-${r}`, cwd: '/', status: r === 3 ? 'paused' : 'active', description: null, last_terminal_at: null, created_at: at, public_id: projectId, is_public: false },
      tabs,
      tasks: r % 2 ? { todo: 2, doing: 1, done: r } : null,
    };
  });
}

let rooms = Array.from({ length: machineCount }, (_, mi) => roomsOf(mi));

/** `?offline=i`, `?silent=i`, `?error=i` put one machine in each of the three notice states. */
function entriesNow(): MachineEntry[] {
  return Array.from({ length: machineCount }, (_, mi): MachineEntry => {
    const id = `m${mi}`;
    // buildCityModel sorts by name, so the names have to sort in index order for `?machine=i` to mean machine i
    const name = mi === 0 ? 'a-maquina-com-um-nome-bem-comprido' : `maquina-${mi}`;
    if (index('error') === mi) return { id, name, online: true, snapshot: null, failed: true };
    const snapshot: OfficeSnapshot = { machine: { id, name } as never, reachable: index('silent') !== mi, rooms: rooms[mi] };
    return { id, name, online: index('offline') !== mi, snapshot, failed: false };
  });
}

const hud = document.getElementById('hud')!;
let target: FocusTarget = { kind: 'city' };
/** Every handler the scene fires, in order: what a click routed to is otherwise unscreenshotable. */
const log = (what: string) => (hud.dataset.picked = `${hud.dataset.picked ?? ''}${what};`);
const go = (t: FocusTarget) => {
  target = t;
  scene.focus(t);
};
const scene = new OfficeScene({
  onPickDesk: (id) => log(`desk:${id}`),
  onPickRoom: (machineId, roomId) => {
    log(`room:${roomId}`);
    go({ kind: 'room', machineId, roomId });
  },
  onPickMachine: (machineId) => {
    log(`machine:${machineId}`);
    go({ kind: 'machine', machineId });
  },
  onPickSign: (id) => log(`sign:${id}`),
  onGoUp: () => {
    log('up');
    go(target.kind === 'room' ? { kind: 'machine', machineId: target.machineId } : { kind: 'city' });
  },
});
// `?grow=1`: the host starts narrow and widens WITHOUT a window resize — what hiding the sidebar in focus mode does
const hostEl = document.getElementById('host')!;
if (q.get('grow')) {
  hostEl.style.width = '75%';
  setTimeout(() => (hostEl.style.width = '100%'), 800);
}
await scene.mount(hostEl);
scene.setModel(buildCityModel(entriesNow(), () => undefined));
// `?machine=i` opens on that machine's block, `?machine=i&room=j` inside one of its rooms
if (q.get('machine') || q.get('room')) {
  const machineId = `m${Math.max(0, index('machine'))}`;
  target = q.get('room') ? { kind: 'room', machineId, roomId: `${machineId}-p${index('room')}` } : { kind: 'machine', machineId };
  scene.focus(target, true);
}
// `?hover=<deskId>` (e.g. m0-t2-0) pins one desk as hovered: hover text cannot be screenshotted otherwise
if (q.get('hover')) scene.debugHover(q.get('hover'));

/**
 * `?churn=tabs`: one desk appears and disappears every second on a machine OTHER than the focused
 * one — the rebuild a tab opened anywhere in the account causes. The camera framing this machine or
 * this room must not move because of it, which is what the two screenshots around it show.
 */
if (q.get('churn') === 'tabs') {
  const focused = target.kind === 'city' ? null : target.machineId;
  const machine = rooms.findIndex((machineRooms, mi) => `m${mi}` !== focused && machineRooms.some((r) => r.tabs.length > 0));
  const roomIndex = machine < 0 ? -1 : rooms[machine].findIndex((r) => r.tabs.length > 0);
  const CHURN_ID = 'churn';
  let extra = false;
  if (machine >= 0)
    setInterval(() => {
      extra = !extra;
      rooms = rooms.map((machineRooms, mi) =>
        mi !== machine
          ? machineRooms
          : machineRooms.map((r, ri) =>
              ri !== roomIndex ? r : { ...r, tabs: extra ? [...r.tabs, { ...r.tabs[0], id: CHURN_ID, name: 'aba recém-aberta', position: r.tabs.length }] : r.tabs.filter((t) => t.id !== CHURN_ID) },
            ),
      );
      scene.setModel(buildCityModel(entriesNow(), () => undefined));
      // how many rebuilds this run has caused, so a screenshot pair can say it really churned
      hud.dataset.churn = String(Number(hud.dataset.churn ?? 0) + 1);
    }, 1000);
}

if (!q.get('still')) {
  setInterval(() => {
    rooms = rooms.map((machineRooms) => machineRooms.map((r) => ({ ...r, tabs: r.tabs.map((t) => (Math.random() < 0.1 ? { ...t, state: STATES[Math.floor(Math.random() * STATES.length)], state_at: new Date().toISOString() } : t)) })));
    scene.setModel(buildCityModel(entriesNow(), () => undefined));
  }, 400);
}
setInterval(() => (hud.textContent = `${Math.round(scene.fps)} fps · ${scene.frameMs.toFixed(2)} ms/frame CPU · ${scene.rendererName}`), 500);
