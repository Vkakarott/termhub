import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import type { ChoicePayload } from './tab-question-payload.js';

vi.mock('./tab-questions.js', () => ({ publishTabQuestions: vi.fn(async () => []) }));
const { publishTabQuestions } = await import('./tab-questions.js');
const { precedentBacks, scheduleAutoAnswer } = await import('./auto-answer.js');

const yesNo = (question: string, header = 'Isolamento'): ChoicePayload['questions'][number] => ({
  question,
  header,
  multi_select: false,
  options: [
    { label: 'Sim', description: '', recommended: false },
    { label: 'Não', description: '', recommended: false },
  ],
});

const decision = (over: Partial<ChatDecision> & { id: string }): ChatDecision => ({
  user_id: 'u1',
  project_id: 'p1',
  project_name: 'termhub',
  conversation_id: null,
  tab_question_id: null,
  question_index: 0,
  header: 'Isolamento',
  question: 'Usar git worktree?',
  options: [{ label: 'Sim', description: '' }, { label: 'Não', description: '' }],
  multi_select: false,
  answer: { labels: ['Sim'] },
  embed_model: 'm',
  suggested_count: 0,
  accepted_count: 0,
  auto_count: 0,
  created_at: '2026-09-24T10:00:00.000Z',
  ...over,
});

const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1',
  tab_id: 't1',
  project_id: 'p1',
  conversation_id: 'c1',
  user_id: 'u1',
  kind: 'choice',
  payload: { questions: [yesNo('Usar git worktree?')] },
  tool_use_id: null,
  status: 'open',
  answer: null,
  error_code: null,
  answered_by: null,
  answered_at: null,
  closed_at: null,
  injected_at: null,
  created_at: '2026-09-26T00:00:00.000Z',
  suggestion: null,
  auto_answer: null,
  answered_via: null,
  woken_at: null,
  ...over,
});

describe('precedentBacks', () => {
  const payload: ChoicePayload = { questions: [yesNo('Usar git worktree?')] };

  it('backs an answer equal to what a cited decision maps to', () => {
    expect(precedentBacks([decision({ id: 'd1' })], payload, { answers: [{ selected: [0] }] })).toBe(true);
  });

  it('matches labels across case and accents (labelKey)', () => {
    const d = decision({ id: 'd1', answer: { labels: ['NAO'] } });
    expect(precedentBacks([d], payload, { answers: [{ selected: [1] }] })).toBe(true);
  });

  it('does not back the opposite answer', () => {
    const d = decision({ id: 'd1', answer: { labels: ['Não'] } });
    expect(precedentBacks([d], payload, { answers: [{ selected: [0] }] })).toBe(false);
  });

  it('compares a free-text answer with sameAnswer (trimmed, exact)', () => {
    const d = decision({ id: 'd1', answer: { labels: [], text: 'usar a branch main ' } });
    expect(precedentBacks([d], payload, { answers: [{ selected: [], text: 'usar a branch main' }] })).toBe(true);
    expect(precedentBacks([d], payload, { answers: [{ selected: [], text: 'usar outra branch' }] })).toBe(false);
  });

  it('needs a backing decision for every question of the card', () => {
    const two: ChoicePayload = { questions: [yesNo('Usar git worktree?'), yesNo('Rodar os testes?', 'Testes')] };
    const d = decision({ id: 'd1' });
    expect(precedentBacks([d], two, { answers: [{ selected: [0] }, { selected: [1] }] })).toBe(false);
    expect(precedentBacks([d], two, { answers: [{ selected: [0] }, { selected: [0] }] })).toBe(true);
  });

  it('no decisions backs nothing', () => {
    expect(precedentBacks([], payload, { answers: [{ selected: [0] }] })).toBe(false);
  });
});

describe('scheduleAutoAnswer', () => {
  beforeEach(() => vi.mocked(publishTabQuestions).mockClear());

  it('stores a scheduled countdown due 60 s from now and republishes the card', async () => {
    const now = new Date('2026-09-26T12:00:00.000Z');
    const setAutoAnswer = vi.fn(async (_id: string, auto: AutoAnswer) => row({ auto_answer: auto }));
    const repos = { tabQuestions: { setAutoAnswer } } as unknown as Repositories;
    const answer = { answers: [{ selected: [0] }] };
    const r = await scheduleAutoAnswer(repos, { row: row(), answer, by: 'concierge', reason: 'motivo', sources: [{ kind: 'decision', id: 'd1' }] }, now);
    expect(setAutoAnswer).toHaveBeenCalledWith('q1', {
      answer,
      by: 'concierge',
      reason: 'motivo',
      sources: [{ kind: 'decision', id: 'd1' }],
      due_at: '2026-09-26T12:01:00.000Z',
      status: 'scheduled',
    });
    expect(r?.auto_answer?.status).toBe('scheduled');
    expect(publishTabQuestions).toHaveBeenCalledWith(repos, 'tab_question', [r]);
  });

  it('a row that moved on (closed, or already counting down) schedules nothing and publishes nothing', async () => {
    const repos = { tabQuestions: { setAutoAnswer: vi.fn(async () => undefined) } } as unknown as Repositories;
    const r = await scheduleAutoAnswer(repos, { row: row(), answer: { answers: [{ selected: [0] }] }, by: 'memory', reason: 'r', sources: [] });
    expect(r).toBeNull();
    expect(publishTabQuestions).not.toHaveBeenCalled();
  });
});
