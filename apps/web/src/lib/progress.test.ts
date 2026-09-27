import { describe, expect, it } from 'vitest';
import type { AgentOnCard, EpicProgress, Tab } from './types';
import { formatDuration, formatEstimate, needsYouAgents, stateLabel, withLiveTab } from './progress';

const agent = (over: Partial<AgentOnCard> = {}): AgentOnCard => ({
  tab_id: 't1', tab_name: 'agent', machine_name: 'jarvis', subtask_ref: null, state: 'working', state_at: '2026-09-27T12:00:00.000Z',
  needs_you: false, activity: 'coding', activity_verb: 'Coding', rate_limited: false, ...over,
});

describe('formatDuration', () => {
  it('shows minutes below an hour and hours with a pt-BR decimal above', () => {
    expect(formatDuration(1200)).toBe('20 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(9000)).toBe('2,5 h');
  });
});

describe('formatEstimate', () => {
  it('writes ranges in one unit when both ends share it', () => {
    expect(formatEstimate({ kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 })).toBe('~20–45 min de trabalho');
    expect(formatEstimate({ kind: 'range', low_s: 3600, high_s: 9000, basis: 'agent_time', samples: 2 })).toBe('~1–2,5 h de trabalho');
  });
  it('writes both units when the range crosses an hour, and one value when the ends match', () => {
    expect(formatEstimate({ kind: 'range', low_s: 2700, high_s: 5400, basis: 'wall_clock', samples: 2 })).toBe('~45 min–1,5 h de trabalho');
    expect(formatEstimate({ kind: 'range', low_s: 300, high_s: 300, basis: 'wall_clock', samples: 2 })).toBe('~5 min de trabalho');
  });
  it('explains the missing estimate', () => {
    expect(formatEstimate({ kind: 'none', reason: 'not_started' })).toBe('ainda não começou');
    expect(formatEstimate({ kind: 'none', reason: 'few_samples' })).toBe('estimativa após 2 subtarefas');
    expect(formatEstimate({ kind: 'done' })).toBe('concluído');
  });
});

describe('stateLabel', () => {
  it('names each state in pt-BR', () => {
    expect(stateLabel('waiting_input')).toBe('esperando você');
    expect(stateLabel('waiting_permission')).toBe('pedindo permissão');
    expect(stateLabel(null)).toBe('sem sinal');
  });
});

describe('withLiveTab', () => {
  it('replaces the state with the live monitor tab', () => {
    const live = { id: 't1', state: 'waiting_permission', state_at: '2026-09-27T12:05:00.000Z', activity: null, activity_verb: null, rate_limited_at: null } as Tab;
    expect(withLiveTab(agent(), live)).toMatchObject({ state: 'waiting_permission', needs_you: true, activity: null, state_at: '2026-09-27T12:05:00.000Z' });
  });
  it('keeps the server value when the monitor does not know the tab', () => {
    expect(withLiveTab(agent(), undefined)).toEqual(agent());
  });
});

describe('needsYouAgents', () => {
  it('collects each waiting tab once across epics', () => {
    const waiting = agent({ tab_id: 't2', needs_you: true, state: 'waiting_input' });
    const card = { agents: [waiting, agent()] } as EpicProgress['cards'][number];
    const epics = [{ cards: [card, card] }, { cards: [{ agents: null }] }] as unknown as EpicProgress[];
    expect(needsYouAgents(epics).map((a) => a.tab_id)).toEqual(['t2']);
  });
});
