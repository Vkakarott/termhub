export interface Point {
  x: number;
  y: number;
}
export interface TimedPoint extends Point {
  /** timestamp em ms (qualquer origem; só as diferenças importam) */
  t: number;
}

export type PointerAction =
  | { type: 'pointerMove'; duration: number; x: number; y: number }
  | { type: 'pointerDown'; button: 0 }
  | { type: 'pointerUp'; button: 0 }
  | { type: 'pause'; duration: number };

export interface PointerSequence {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'touch' };
  actions: PointerAction[];
}

/** Corpo de `POST /session/:id/actions` (WebDriver W3C Actions). */
export interface W3CActions {
  actions: PointerSequence[];
}

const MIN_MOVE_MS = 1;
const MAX_MOVE_MS = 2000;

const seq = (actions: PointerAction[]): W3CActions => ({
  actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }],
});

const round = (n: number) => Math.round(n);

export function tapActions(p: Point): W3CActions {
  return seq([
    { type: 'pointerMove', duration: 0, x: round(p.x), y: round(p.y) },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 80 },
    { type: 'pointerUp', button: 0 },
  ]);
}

export function dragActions(points: TimedPoint[]): W3CActions {
  if (points.length === 0) throw new Error('drag sem pontos');
  if (points.length === 1) return tapActions(points[0]);
  const [first, ...rest] = points;
  const actions: PointerAction[] = [
    { type: 'pointerMove', duration: 0, x: round(first.x), y: round(first.y) },
    { type: 'pointerDown', button: 0 },
  ];
  let prev = first;
  for (const p of rest) {
    const duration = Math.min(MAX_MOVE_MS, Math.max(MIN_MOVE_MS, round(p.t - prev.t)));
    actions.push({ type: 'pointerMove', duration, x: round(p.x), y: round(p.y) });
    prev = p;
  }
  actions.push({ type: 'pointerUp', button: 0 });
  return seq(actions);
}
