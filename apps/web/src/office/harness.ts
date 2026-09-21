/** Dev tool: the office scene with synthetic data, no login and no server — for screenshots and frame timing. */
import type { OfficeRoom, OfficeSnapshot, OfficeTab, TabState } from '../lib/types';
import { buildModel } from './model';
import { OfficeScene } from './scene/OfficeScene';

const STATES: Array<TabState | null> = ['working', 'working', 'working', 'waiting_input', 'waiting_permission', 'idle', 'idle', 'error', null];
const q = new URLSearchParams(location.search);
const roomCount = Number(q.get('rooms')) || 6;
const deskMax = Number(q.get('desks')) || 8;
const at = new Date().toISOString();

const rooms: OfficeRoom[] = Array.from({ length: roomCount }, (_, r) => {
  const n = r === 1 ? 0 : 1 + ((r * 5) % deskMax);
  const tabs = Array.from({ length: n }, (_, i): OfficeTab => {
    const state = STATES[(r + i) % STATES.length];
    return { id: `t${r}-${i}`, project_id: `p${r}`, name: i === 0 ? 'um nome de aba bem comprido mesmo 🚀' : `aba ${i + 1}`, kind: i % 7 === 6 ? 'simulator' : 'terminal', tmux_session: null, simulator_udid: null, position: i, state, state_text: null, state_tool: null, state_at: state ? at : null, state_seen_at: null, created_at: at, alive: i % 9 !== 8, progress: i % 3 === 0 ? { task_id: 'k', title: 'Tarefa', done: i % 4, total: 4 } : null };
  });
  return { project: { id: `p${r}`, machine_id: 'm', name: r === 0 ? 'projeto com um nome enorme para testar o corte' : `projeto-${r}`, cwd: '/', status: r === 3 ? 'paused' : 'active', description: null, last_terminal_at: null, created_at: at }, tabs, tasks: r % 2 ? { todo: 2, doing: 1, done: r } : null };
});
let snapshot: OfficeSnapshot = { machine: { id: 'm', name: 'harness' } as never, reachable: true, rooms };

const hud = document.getElementById('hud')!;
const scene = new OfficeScene({
  onPickDesk: (id) => (hud.dataset.picked = id),
  onPickRoom: (id) => scene.focusRoom(id),
  onPickSign: (id) => (hud.dataset.sign = id),
  onLeaveRoom: () => scene.focusRoom(null),
});
await scene.mount(document.getElementById('host')!);
scene.setModel(buildModel(snapshot, () => undefined));
if (q.get('room')) scene.focusRoom(`p${q.get('room')}`, true);

if (!q.get('still')) {
  setInterval(() => {
    snapshot = { ...snapshot, rooms: snapshot.rooms.map((r) => ({ ...r, tabs: r.tabs.map((t) => (Math.random() < 0.1 ? { ...t, state: STATES[Math.floor(Math.random() * STATES.length)], state_at: new Date().toISOString() } : t)) })) };
    scene.setModel(buildModel(snapshot, () => undefined));
  }, 400);
}
setInterval(() => (hud.textContent = `${Math.round(scene.fps)} fps · ${scene.frameMs.toFixed(2)} ms/frame CPU · ${scene.rendererName}`), 500);
