import { expect, it } from 'vitest';
import type { TabQuestion } from './tab-questions.js';
import { toTabQuestionView } from './tab-questions-view.js';

const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null,
  status: 'answered_in_tab', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: '2026-09-26T12:00:00.000Z', injected_at: null, created_at: '2026-09-26T11:59:00.000Z', ...over,
});

it('never puts the permission queue mark on the wire; a failure code still travels (spec 2026-09-26 §4.2)', () => {
  expect(toTabQuestionView(row({ error_code: 'QUEUED' }), 'api').error_code).toBeNull();
  expect(toTabQuestionView(row({ status: 'failed', error_code: 'MACHINE_OFFLINE' }), 'api').error_code).toBe('MACHINE_OFFLINE');
});

it('a suggestion always carries context on the wire: null for a row stored before TER-96', () => {
  const s = row({ kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', closed_at: null });
  expect(toTabQuestionView(s, 'api').payload).toEqual({ text: 'commit it', context: null });
  expect(toTabQuestionView({ ...s, payload: { text: 'commit it', context: 'Quer que eu faça o commit?' } }, 'api').payload).toEqual({ text: 'commit it', context: 'Quer que eu faça o commit?' });
  expect(toTabQuestionView(row(), 'api').payload).toEqual({ tool_name: 'Bash' }); // questions untouched
});

it('a Codex reply card carries agent on the wire; a Claude suggestion has no agent key', () => {
  const codex = row({ kind: 'suggestion', payload: { text: '', context: 'Rodo os testes?', agent: 'codex' }, status: 'open', closed_at: null });
  expect(toTabQuestionView(codex, 'api').payload).toEqual({ text: '', context: 'Rodo os testes?', agent: 'codex' });
  const claude = toTabQuestionView(row({ kind: 'suggestion', payload: { text: 'commit it', context: 'Quer?' }, status: 'open', closed_at: null }), 'api').payload;
  expect(claude).not.toHaveProperty('agent');
});

it('carries the countdown while the card is open, and afterwards only once sent or failed (spec 2026-09-26 concierge memory §6)', () => {
  const auto = { answer: { answers: [{ selected: [0] }] }, by: 'memory' as const, reason: 'r', sources: [{ kind: 'decision' as const, id: 'd1' }], due_at: '2026-09-26T12:01:00.000Z' };
  const open = row({ kind: 'choice', payload: { questions: [] }, status: 'open', closed_at: null });
  for (const status of ['scheduled', 'cancelled', 'sent', 'failed'] as const) {
    expect(toTabQuestionView({ ...open, auto_answer: { ...auto, status } }, 'api').auto_answer).toEqual({ ...auto, status });
  }
  const answered = { ...open, status: 'answered' as const };
  expect(toTabQuestionView({ ...answered, auto_answer: { ...auto, status: 'sent' }, answered_via: 'auto' }, 'api')).toMatchObject({ auto_answer: { status: 'sent' }, answered_via: 'auto' });
  expect(toTabQuestionView({ ...answered, auto_answer: { ...auto, status: 'failed', error_code: 'TAB_PROMPT_CHANGED' } }, 'api').auto_answer?.status).toBe('failed');
  expect(toTabQuestionView({ ...answered, auto_answer: { ...auto, status: 'cancelled' }, answered_via: 'card' }, 'api')).toMatchObject({ auto_answer: null, answered_via: 'card' });
  expect(toTabQuestionView(row(), 'api')).toMatchObject({ auto_answer: null, answered_via: null });
});

it('carries surfaced_at, null until the card is brought back (TER-477)', () => {
  expect(toTabQuestionView(row(), 'api').surfaced_at).toBeNull();
  expect(toTabQuestionView(row({ surfaced_at: '2026-09-30T06:00:00.000Z' }), 'api').surfaced_at).toBe('2026-09-30T06:00:00.000Z');
});
