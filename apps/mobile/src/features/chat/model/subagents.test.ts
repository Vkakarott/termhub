import { elapsedLabel, upsertSubagent } from './subagents';
import type { SubagentView } from './types';

const sub = (over: Partial<SubagentView> & { id: string }): SubagentView => ({
  description: 'Buscar CI',
  subagent_type: null,
  status: 'running',
  started_at: '2026-09-27T00:00:00.000Z',
  ended_at: null,
  ...over,
});

it('reads "há 3 min" for a subagent running for 3 minutes', () => {
  const s = sub({ id: 's1', status: 'running', started_at: '2026-09-27T00:00:00.000Z' });
  const now = new Date('2026-09-27T00:03:00.000Z').getTime();
  expect(elapsedLabel(s, now)).toBe('há 3 min');
});

it('reads "levou 2 min" once it ended', () => {
  const s = sub({ id: 's1', status: 'completed', started_at: '2026-09-27T00:00:00.000Z', ended_at: '2026-09-27T00:02:00.000Z' });
  // `now` must not matter once the row has ended.
  expect(elapsedLabel(s, new Date('2026-09-27T00:10:00.000Z').getTime())).toBe('levou 2 min');
});

it('reads "há menos de 1 min" under a minute', () => {
  const s = sub({ id: 's1', status: 'running', started_at: '2026-09-27T00:00:00.000Z' });
  const now = new Date('2026-09-27T00:00:20.000Z').getTime();
  expect(elapsedLabel(s, now)).toBe('há menos de 1 min');
});

it('upsertSubagent replaces an existing row by id and prepends a new one', () => {
  const s1 = sub({ id: 's1', description: 'primeira' });
  const replaced = upsertSubagent([s1], sub({ id: 's1', description: 'atualizada' }));
  expect(replaced).toHaveLength(1);
  expect(replaced[0]!.description).toBe('atualizada');

  const withNew = upsertSubagent(replaced, sub({ id: 's2', description: 'nova' }));
  expect(withNew.map((s) => s.id)).toEqual(['s2', 's1']);
});
