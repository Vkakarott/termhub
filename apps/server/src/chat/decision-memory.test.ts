import { describe, expect, it, vi } from 'vitest';
import type { DecisionNeighbour } from '../db/repositories/chat-decisions.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { suggestFor } from './decision-memory.js';
import { EmbedError } from './embeddings.js';
import type { ChoicePayload } from './tab-question-payload.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const embedder = () => ({ embed: vi.fn(async (texts: string[]) => ({ model: 'm', vectors: texts.map(() => [1, 0]) })) });

const item = { question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] };
const payload: ChoicePayload = { questions: [item] };
const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload, tool_use_id: 'toolu_1',
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', suggestion: null, ...over,
});

let seq = 0;
function neighbour(over: Partial<DecisionNeighbour> = {}): DecisionNeighbour {
  seq += 1;
  return {
    id: `d${seq}`, user_id: 'u1', project_id: 'p1', project_name: 'Proj', conversation_id: 'c1', tab_question_id: null,
    question_index: 0, header: 'Cor', question: 'Qual cor?', options: [{ label: 'Sim', description: '' }, { label: 'Não', description: '' }],
    multi_select: false, answer: { labels: ['Sim'] }, embed_model: 'm', suggested_count: 0, accepted_count: 0,
    created_at: '2026-09-20T00:00:00.000Z', similarity: 0.9, ...over,
  };
}

function fakeRepos(opts: { chatSuggestions?: boolean; nearest?: (userId: string, vector: number[], opts: { multiSelect: boolean; k: number }) => Promise<DecisionNeighbour[]> } = {}) {
  return {
    users: { chatSuggestions: vi.fn(async () => opts.chatSuggestions ?? true) },
    chatDecisions: { nearest: vi.fn(opts.nearest ?? (async () => [])), bumpSuggested: vi.fn(async () => {}) },
  };
}

describe('suggestFor', () => {
  it('pre-selects the most recent candidate above the threshold', async () => {
    const older = neighbour({ id: 'd-old', similarity: 0.95, created_at: '2026-09-10T00:00:00.000Z', answer: { labels: ['Não'] } });
    const newer = neighbour({ id: 'd-new', similarity: 0.9, created_at: '2026-09-20T00:00:00.000Z', answer: { labels: ['Sim'] } });
    const repos = fakeRepos({ nearest: async () => [older, newer] });
    const l = log();
    const result = await suggestFor(repos as never, row(), { embedder: embedder(), threshold: 0.85, log: l });
    expect(result).toEqual({
      items: [{ question_index: 0, decision_id: 'd-new', similarity: 0.9, selected: [0], source: { question: newer.question, project_name: newer.project_name, answered_at: newer.created_at } }],
    });
    expect(repos.chatDecisions.bumpSuggested).toHaveBeenCalledWith(['d-new']);
    expect(l.info).toHaveBeenCalledWith({ tabQuestionId: 'q1', items: 1, best: 0.9 }, expect.any(String));
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('Qual cor');
  });

  it('ignores candidates below the threshold', async () => {
    const below = neighbour({ id: 'd-low', similarity: 0.84, answer: { labels: ['Sim'] } });
    const repos = fakeRepos({ nearest: async () => [below] });
    const result = await suggestFor(repos as never, row(), { embedder: embedder(), threshold: 0.85, log: log() });
    expect(result).toBeNull();
    expect(repos.chatDecisions.bumpSuggested).not.toHaveBeenCalled();
  });

  it('skips a candidate whose labels do not map to the current options', async () => {
    const older = neighbour({ id: 'd-old', similarity: 0.9, created_at: '2026-09-10T00:00:00.000Z', answer: { labels: ['Sim'] } });
    const newer = neighbour({ id: 'd-new', similarity: 0.95, created_at: '2026-09-20T00:00:00.000Z', answer: { labels: ['Talvez'] } });
    const repos = fakeRepos({ nearest: async () => [older, newer] });
    const result = await suggestFor(repos as never, row(), { embedder: embedder(), threshold: 0.85, log: log() });
    expect(result?.items).toEqual([{ question_index: 0, decision_id: 'd-old', similarity: 0.9, selected: [0], source: { question: older.question, project_name: older.project_name, answered_at: older.created_at } }]);
    expect(repos.chatDecisions.bumpSuggested).toHaveBeenCalledWith(['d-old']);
  });

  it('embeds every question in one call and asks nearest per question with its multi-select shape', async () => {
    const item1 = { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: [{ label: 'Maçã', description: '', recommended: false }, { label: 'Banana', description: '', recommended: false }] };
    const twoQuestions: ChoicePayload = { questions: [item, item1] };
    const match = neighbour({ id: 'd-match', similarity: 0.9, question_index: 0, answer: { labels: ['Sim'] } });
    const nearest = vi.fn(async (_userId: string, _vector: number[], opts: { multiSelect: boolean; k: number }) => (opts.multiSelect ? [] : [match]));
    const repos = { users: { chatSuggestions: vi.fn(async () => true) }, chatDecisions: { nearest, bumpSuggested: vi.fn(async () => {}) } };
    const e = embedder();
    const result = await suggestFor(repos as never, row({ payload: twoQuestions }), { embedder: e, threshold: 0.85, log: log() });
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(e.embed.mock.calls[0]![0]).toHaveLength(2);
    expect(result?.items).toEqual([{ question_index: 0, decision_id: 'd-match', similarity: 0.9, selected: [0], source: { question: match.question, project_name: match.project_name, answered_at: match.created_at } }]);
    expect(nearest).toHaveBeenCalledWith('u1', [1, 0], { multiSelect: false, k: 5 });
    expect(nearest).toHaveBeenCalledWith('u1', [1, 0], { multiSelect: true, k: 5 });
  });

  it('gives null without calling the embedder for a non-choice row, no embedder, or suggestions off', async () => {
    const e = embedder();
    expect(await suggestFor(fakeRepos() as never, row({ kind: 'permission', payload: { tool_name: 'Bash' } as never }), { embedder: e, threshold: 0.85, log: log() })).toBeNull();
    expect(await suggestFor(fakeRepos() as never, row(), { embedder: null, threshold: 0.85, log: log() })).toBeNull();
    expect(await suggestFor(fakeRepos({ chatSuggestions: false }) as never, row(), { embedder: e, threshold: 0.85, log: log() })).toBeNull();
    expect(e.embed).not.toHaveBeenCalled();
  });

  it('logs a warning and returns null when the embedder rejects', async () => {
    const repos = fakeRepos();
    const l = log();
    const failing = { embed: vi.fn(async () => { throw new EmbedError('EMBED_UNREACHABLE'); }) };
    const result = await suggestFor(repos as never, row(), { embedder: failing, threshold: 0.85, log: l });
    expect(result).toBeNull();
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', code: 'EMBED_UNREACHABLE' }, expect.any(String));
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('Qual cor');
  });

  it('resolves null within the timeout when the embedder hangs', async () => {
    const repos = fakeRepos();
    const hanging = { embed: vi.fn(() => new Promise<never>(() => {})) };
    const start = Date.now();
    const result = await suggestFor(repos as never, row(), { embedder: hanging, threshold: 0.85, timeoutMs: 20, log: log() });
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('logs a warning and returns null when nearest rejects', async () => {
    const repos = fakeRepos({
      nearest: async () => {
        throw Object.assign(new Error('db down'), { code: 'P2024' });
      },
    });
    const l = log();
    const result = await suggestFor(repos as never, row(), { embedder: embedder(), threshold: 0.85, log: l });
    expect(result).toBeNull();
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', code: 'P2024' }, expect.any(String));
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('Qual cor');
  });
});
