import { formatDuration, formatEstimate, stateLabel } from './format';

it('formats durations', () => {
  expect(formatDuration(1200)).toBe('20 min');
  expect(formatDuration(3600)).toBe('1 h');
  expect(formatDuration(9000)).toBe('2,5 h');
});
it('formats estimates', () => {
  expect(formatEstimate({ kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 })).toBe('~20–45 min de trabalho');
  expect(formatEstimate({ kind: 'range', low_s: 2700, high_s: 5400, basis: 'wall_clock', samples: 2 })).toBe('~45 min–1,5 h de trabalho');
  expect(formatEstimate({ kind: 'range', low_s: 300, high_s: 300, basis: 'wall_clock', samples: 2 })).toBe('~5 min de trabalho');
  expect(formatEstimate({ kind: 'none', reason: 'not_started' })).toBe('ainda não começou');
  expect(formatEstimate({ kind: 'none', reason: 'few_samples' })).toBe('estimativa após 2 subtarefas');
  expect(formatEstimate({ kind: 'done' })).toBe('concluído');
});
it('names states', () => {
  expect(stateLabel('waiting_input')).toBe('esperando você');
  expect(stateLabel(null)).toBe('sem sinal');
});
