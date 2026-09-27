import { describe, expect, it } from 'vitest';
import { progressEstimate, progressResponse } from './progress.js';

const card = {
  id: 'c1', ref: 'TER-2', title: 'Card', type: 'story', status: 'doing', column_name: 'Fazendo',
  units: { done: 1, total: 2 }, percent: 50, started_at: null, done_at: null, active_seconds: 0,
  estimate: { kind: 'none', reason: 'few_samples' }, agents: null,
};
const epic = {
  id: 'e1', ref: 'TER-1', title: 'Epic', project: { id: 'p1', key: 'TER', name: 'termhub' },
  units: { done: 1, total: 2, backlog_total: 0 }, percent: 50, estimate: { kind: 'none', reason: 'few_samples' },
  cards_without_estimate: 1, agents: null, cards: [card],
};

describe('progress contract', () => {
  it('accepts a full response', () => {
    expect(progressResponse.parse({ epics: [epic], generated_at: '2026-09-27T12:00:00.000Z' }).epics[0].cards[0].ref).toBe('TER-2');
  });
  it('accepts a range estimate and rejects an unknown basis', () => {
    expect(progressEstimate.parse({ kind: 'range', low_s: 600, high_s: 1800, basis: 'agent_time', samples: 3 }).kind).toBe('range');
    expect(() => progressEstimate.parse({ kind: 'range', low_s: 600, high_s: 1800, basis: 'guess', samples: 3 })).toThrow();
  });
  it('rejects a percent above 100', () => {
    expect(() => progressResponse.parse({ epics: [{ ...epic, percent: 101 }], generated_at: 'x' })).toThrow();
  });
});
