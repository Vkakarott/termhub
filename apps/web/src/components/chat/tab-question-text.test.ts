import { expect, it } from 'vitest';
import type { TabQuestion } from '../../lib/types';
import { answerSummary, statusLabel, suggestionLine, tabLabel, upsertTabQuestion } from './tab-question-text';

const base = { id: 'q1', tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
const choice = (over: Partial<TabQuestion> = {}) =>
  ({ ...base, kind: 'choice', status: 'open', answer: null, payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }, { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: [{ label: 'Maçã', description: '', recommended: false }, { label: 'Manga', description: '', recommended: false }] }] }, ...over }) as TabQuestion;
const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

it('names the tab, or says it is gone', () => {
  expect(tabLabel(choice())).toBe('A aba «api»');
  expect(tabLabel(choice({ tab_name: null }))).toBe('Uma aba');
});
it('states in pt-BR', () => {
  expect(statusLabel(choice())).toBe('');
  expect(statusLabel(choice({ status: 'answered' }))).toBe('Respondida');
  expect(statusLabel(choice({ status: 'answered_in_tab' }))).toBe('Respondida na aba');
  expect(statusLabel(choice({ status: 'expired' }))).toBe('Expirada');
  expect(statusLabel(choice({ status: 'failed', error_code: 'MACHINE_OFFLINE' }))).toBe('Falhou — a máquina está offline');
  expect(statusLabel(choice({ status: 'failed', error_code: 'WHATEVER' }))).toBe('Falhou — não foi possível digitar na aba');
});
it('summarises what was answered', () => {
  expect(answerSummary(choice({ status: 'answered', answer: { answers: [{ selected: [1] }, { selected: [0, 1] }] } }))).toEqual(['Qual cor? → Verde', 'Quais frutas? → Maçã, Manga']);
  expect(answerSummary(choice({ status: 'answered', answer: { answers: [{ selected: [], text: 'Roxo' }, { selected: [0] }] } }))[0]).toBe('Qual cor? → Roxo');
  expect(answerSummary(choice({ status: 'answered_in_tab' }))).toEqual(['Qual cor?', 'Quais frutas?']);
  expect(answerSummary(permission({ status: 'answered', answer: { allow: true } }))).toEqual(['Permitido']);
  expect(answerSummary(permission({ status: 'answered', answer: { allow: false, text: 'use pnpm' } }))).toEqual(['Negado: «use pnpm»']);
  expect(answerSummary(permission({ status: 'answered', answer: { allow: false } }))).toEqual(['Negado']);
  expect(answerSummary(permission({ status: 'expired' }))).toEqual([]);
});
it('names the suggestion\'s source (an option, or free text) in pt-BR', () => {
  const item = choice().payload.questions[0]!;
  expect(
    suggestionLine(item, { question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [1], source: { question: 'Qual cor prefere?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }),
  ).toBe('Sugestão da memória: você respondeu «Verde» a «Qual cor prefere?» em termhub, 20/09/2026');
  expect(
    suggestionLine(item, { question_index: 0, decision_id: 'd2', similarity: 0.9, selected: [], text: 'Roxo', source: { question: 'Qual cor prefere?', project_name: null, answered_at: '2026-09-20T10:00:00.000Z' } }),
  ).toBe('Sugestão da memória: você respondeu «Roxo» a «Qual cor prefere?» em outro projeto, 20/09/2026');
});

it('upserts by id, appending a new one', () => {
  const list = [choice()];
  expect(upsertTabQuestion(list, choice({ status: 'answered' }))).toEqual([choice({ status: 'answered' })]);
  expect(upsertTabQuestion(list, permission({ id: 'q2' }))).toHaveLength(2);
});
