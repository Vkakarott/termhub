import { expect, it } from 'vitest';
import { openAnswersIn } from './open-answers.js';

const row = (id: string, role: 'user' | 'assistant', text = '', error_code: string | null = null) => ({ id, role, text, error_code });

it('keeps only the empty assistant rows that are open, in the order of the thread', () => {
  const messages = [row('q1', 'user', 'oi'), row('a1', 'assistant', 'olá'), row('q2', 'user', 'e agora?'), row('a2', 'assistant'), row('q3', 'user', 'mais'), row('a3', 'assistant')];
  expect(openAnswersIn(messages, ['a3', 'a2', 'a1'])).toEqual(['a2', 'a3']);
});

it('leaves out a row that ended in an error, a row of the person and an id the thread lacks', () => {
  const messages = [row('q1', 'user', ''), row('a1', 'assistant', '', 'RUN_FAILED'), row('a2', 'assistant')];
  expect(openAnswersIn(messages, ['q1', 'a1', 'gone'])).toEqual([]);
});

it('lists an id once, however many sources named it', () => {
  expect(openAnswersIn([row('a1', 'assistant')], ['a1', 'a1'])).toEqual(['a1']);
});

it('an empty row nobody owns is not open', () => {
  expect(openAnswersIn([row('a1', 'assistant')], [])).toEqual([]);
});
