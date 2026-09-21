/** SPIKE (throwaway): drives OfficeScene with synthetic tabs — `?demo=N` (default 40), `?still=1` stops the state churn. */
import type { TabState } from '../lib/types';
import { OfficeScene, type DeskInput } from './OfficeScene';

const STATES: Array<TabState | null> = ['working', 'working', 'working', 'waiting_input', 'waiting_permission', 'idle', 'idle', 'error', null];
const q = new URLSearchParams(location.search);
const count = Number(q.get('demo')) || 40;
let desks: DeskInput[] = Array.from({ length: count }, (_, i) => ({
  id: `demo-${i}`,
  name: `aba ${i + 1}`,
  state: STATES[i % STATES.length],
  kind: i % 11 === 10 ? 'phone' : 'person',
}));

const hud = document.getElementById('hud')!;
const scene = new OfficeScene((id) => (hud.dataset.picked = id));
await scene.mount(document.getElementById('host')!);
scene.setDesks(desks);

if (!q.get('still')) {
  setInterval(() => {
    desks = desks.map((d) => (Math.random() < 0.1 ? { ...d, state: STATES[Math.floor(Math.random() * STATES.length)] } : d));
    scene.setDesks(desks);
  }, 400);
}
const samples: number[] = [];
setInterval(() => {
  samples.push(scene.fps);
  const avg = samples.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, samples.length);
  hud.textContent = `${Math.round(scene.fps)} fps (média ${avg.toFixed(1)}) · ${scene.frameMs.toFixed(2)} ms/frame CPU · ${scene.rendererName} · ${count} mesas`;
}, 500);
