import { describe, expect, it } from 'vitest';
import { estimateCard, roundDuration, type EstimateInput } from './estimate.js';

const at = (min: number) => new Date(Date.UTC(2026, 8, 27, 12, 0) + min * 60_000);
const input = (over: Partial<EstimateInput>): EstimateInput => ({ status: 'doing', units: { done: 0, total: 4 }, active_seconds: 0, started_at: null, unit_done_at: [], ...over });

describe('roundDuration', () => {
  it('rounds to 5 min below an hour with a 5 min floor, to 30 min above', () => {
    expect(roundDuration(10)).toBe(300);
    expect(roundDuration(1260)).toBe(1200);
    expect(roundDuration(3700)).toBe(3600);
    expect(roundDuration(4600)).toBe(5400);
  });
});

describe('estimateCard', () => {
  it('is done for a done card, or when every unit is done', () => {
    expect(estimateCard(input({ status: 'done' }))).toEqual({ kind: 'done' });
    expect(estimateCard(input({ units: { done: 4, total: 4 } }))).toEqual({ kind: 'done' });
  });
  it('is not_started when nothing started, no time and no unit done', () => {
    expect(estimateCard(input({ status: 'todo' }))).toEqual({ kind: 'none', reason: 'not_started' });
  });
  it('is never not_started for a card in doing (in flight before started_at existed)', () => {
    expect(estimateCard(input({ status: 'doing' }))).toEqual({ kind: 'none', reason: 'few_samples' });
  });
  it('needs two finished units', () => {
    expect(estimateCard(input({ started_at: at(0) }))).toEqual({ kind: 'none', reason: 'few_samples' });
    expect(estimateCard(input({ units: { done: 1, total: 4 }, active_seconds: 600 }))).toEqual({ kind: 'none', reason: 'few_samples' });
  });
  it('uses agent time when there is some: 2 done in 20 min, 2 left → 20 min × [0.5, 2]', () => {
    expect(estimateCard(input({ units: { done: 2, total: 4 }, active_seconds: 1200 }))).toEqual({ kind: 'range', low_s: 600, high_s: 2400, basis: 'agent_time', samples: 2 });
  });
  it('narrows the band from 5 samples on', () => {
    const e = estimateCard(input({ units: { done: 5, total: 6 }, active_seconds: 3000 }));
    // 600 s per unit, 1 left → [420, 900] → 420 rounds to 300
    expect(e).toEqual({ kind: 'range', low_s: 300, high_s: 900, basis: 'agent_time', samples: 5 });
  });
  it('falls back to wall clock from the start to the last finished unit', () => {
    const e = estimateCard(input({ units: { done: 2, total: 3 }, started_at: at(0), unit_done_at: [at(10), at(30)] }));
    // 30 min / 2 units = 15 min per unit, 1 left → [7.5, 30] min → rounded
    expect(e).toEqual({ kind: 'range', low_s: 600, high_s: 1800, basis: 'wall_clock', samples: 2 });
  });
  it('without a start, measures between finished units only', () => {
    const e = estimateCard(input({ units: { done: 2, total: 3 }, unit_done_at: [at(30), at(10)] }));
    // one interval of 20 min → 20 min per unit, 1 left → [10, 40] min
    expect(e).toEqual({ kind: 'range', low_s: 600, high_s: 2400, basis: 'wall_clock', samples: 2 });
  });
  it('ignores a start later than the first finished unit', () => {
    const e = estimateCard(input({ units: { done: 2, total: 3 }, started_at: at(20), unit_done_at: [at(10), at(30)] }));
    expect(e).toEqual({ kind: 'range', low_s: 600, high_s: 2400, basis: 'wall_clock', samples: 2 });
  });
  it('gives up when the finished units have no usable span', () => {
    expect(estimateCard(input({ units: { done: 2, total: 3 }, unit_done_at: [at(10), at(10)] }))).toEqual({ kind: 'none', reason: 'few_samples' });
  });
});
