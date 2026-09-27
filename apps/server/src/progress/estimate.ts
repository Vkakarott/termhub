import type { ProgressEstimate } from '@termhub/mobile-api';

/** Finished units needed before a card gets a range (spec 2026-09-26 progress-panel D4). */
export const MIN_SAMPLES = 2;
/** From this many samples on the band narrows from [×0.5, ×2] to [×0.7, ×1.5]. */
const NARROW_FROM = 5;

export interface EstimateInput {
  status: 'backlog' | 'todo' | 'doing' | 'done';
  units: { done: number; total: number };
  active_seconds: number;
  started_at: Date | null;
  /** when each finished unit finished: the subtasks', or the card's own when it has none */
  unit_done_at: Date[];
}

/** Below an hour to 5 min (never under 5 min), from an hour on to 30 min. */
export function roundDuration(seconds: number): number {
  if (seconds < 3600) return Math.max(300, Math.round(seconds / 300) * 300);
  return Math.round(seconds / 1800) * 1800;
}

/** Seconds per unit: agent time when the card has some, else wall clock between finished units. */
function paceOf(input: EstimateInput): { seconds: number; basis: 'agent_time' | 'wall_clock' } | null {
  const done = input.units.done;
  if (input.active_seconds > 0) return { seconds: input.active_seconds / done, basis: 'agent_time' };
  const times = input.unit_done_at.map((d) => d.getTime()).sort((a, b) => a - b);
  if (times.length === 0) return null;
  const start = input.started_at?.getTime();
  const fromStart = start !== undefined && start <= times[0];
  const span = times[times.length - 1] - (fromStart ? start : times[0]);
  const intervals = fromStart ? times.length : times.length - 1;
  if (intervals < 1 || span <= 0) return null;
  return { seconds: span / 1000 / intervals, basis: 'wall_clock' };
}

export function estimateCard(input: EstimateInput): ProgressEstimate {
  const { done, total } = input.units;
  if (input.status === 'done' || (total > 0 && done >= total)) return { kind: 'done' };
  // A card in doing has started, even without a stamp (cards already in doing when started_at was added).
  if (input.status !== 'doing' && done === 0 && !input.started_at && input.active_seconds === 0) return { kind: 'none', reason: 'not_started' };
  if (done < MIN_SAMPLES) return { kind: 'none', reason: 'few_samples' };
  const pace = paceOf(input);
  if (!pace) return { kind: 'none', reason: 'few_samples' };
  const mid = (total - done) * pace.seconds;
  const [low, high] = done >= NARROW_FROM ? [0.7, 1.5] : [0.5, 2];
  return { kind: 'range', low_s: roundDuration(mid * low), high_s: roundDuration(mid * high), basis: pace.basis, samples: done };
}
