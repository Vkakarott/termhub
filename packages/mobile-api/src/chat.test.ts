import { describe, expect, it } from 'vitest';
import { decisionsResponse, isTabGrantable, mobileBatchDecisionBody, mobileDecisionBody, mobileMessageBody } from './chat.js';
import { tabQuestionSchema } from './events.js';

describe('mobileDecisionBody', () => {
  it('accepts approve_tab with a challenge and a PIN proof, and refuses it without', () => {
    expect(mobileDecisionBody.safeParse({ decision: 'approve_tab', challenge: 'c', pin_proof: 'p' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve_tab' }).success).toBe(false);
  });

  it('accepts approve with both challenge and PIN proof or with neither, never with only one', () => {
    expect(mobileDecisionBody.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', challenge: 'c', pin_proof: 'p' }).success).toBe(true);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', challenge: 'c' }).success).toBe(false);
    expect(mobileDecisionBody.safeParse({ decision: 'approve', pin_proof: 'p' }).success).toBe(false);
  });
});

describe('mobileBatchDecisionBody', () => {
  const ok = (decisions: unknown) => mobileBatchDecisionBody.safeParse({ decisions }).success;
  it('accepts a deny-only batch, approvals carrying their own proof, and approvals with none (TER-92: the server decides)', () => {
    expect(ok([{ id: 'a1', decision: 'deny' }])).toBe(true);
    expect(ok([{ id: 'a1', decision: 'approve', challenge: 'c', pin_proof: 'p' }, { id: 'a2', decision: 'deny' }])).toBe(true);
    expect(ok([{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'approve', challenge: 'c', pin_proof: 'p' }])).toBe(true);
  });
  it('refuses half a proof, approve_tab, repeated ids and an empty batch', () => {
    expect(ok([{ id: 'a1', decision: 'approve', challenge: 'c' }])).toBe(false);
    expect(ok([{ id: 'a1', decision: 'approve', pin_proof: 'p' }])).toBe(false);
    expect(ok([{ id: 'a1', decision: 'approve_tab', challenge: 'c', pin_proof: 'p' }])).toBe(false);
    expect(ok([{ id: 'a1', decision: 'deny' }, { id: 'a1', decision: 'deny' }])).toBe(false);
    expect(ok([])).toBe(false);
  });
});

describe('isTabGrantable', () => {
  const base = { tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, tab_id: 't1' };
  it('is only send_input to a tab, not answering a permission', () => {
    expect(isTabGrantable(base)).toBe(true);
    expect(isTabGrantable({ ...base, args: { tab_id: 't1', text: '1', answering_permission: true } })).toBe(false);
    expect(isTabGrantable({ ...base, tool: 'run_command' })).toBe(false);
    expect(isTabGrantable({ ...base, tab_id: null })).toBe(false);
  });
});

describe('mobileMessageBody', () => {
  it('accepts text alone, attachments alone, and refuses neither', () => {
    expect(mobileMessageBody.safeParse({ text: 'oi' }).success).toBe(true);
    expect(mobileMessageBody.parse({ text: '  ', attachment_ids: ['a1'] })).toEqual({ text: '', attachment_ids: ['a1'] });
    expect(mobileMessageBody.safeParse({ text: '   ' }).success).toBe(false);
    expect(mobileMessageBody.safeParse({ text: '', attachment_ids: [] }).success).toBe(false);
    expect(mobileMessageBody.safeParse({ attachment_ids: ['a1'] }).success).toBe(true);
  });

  it('caps attachments at 5 and text at 8000', () => {
    expect(mobileMessageBody.safeParse({ text: 'oi', attachment_ids: ['1', '2', '3', '4', '5'] }).success).toBe(true);
    expect(mobileMessageBody.safeParse({ text: 'oi', attachment_ids: ['1', '2', '3', '4', '5', '6'] }).success).toBe(false);
    expect(mobileMessageBody.safeParse({ text: 'x'.repeat(8001) }).success).toBe(false);
  });
});

describe('decisionsResponse', () => {
  it('parses a page of decisions with a next cursor', () => {
    const sample = {
      decisions: [
        {
          id: 'd1',
          project_id: 'p1',
          project_name: 'Projeto X',
          header: 'Escolha o gerenciador de pacotes',
          question: 'Qual gerenciador de pacotes devo usar?',
          options: [{ label: 'npm', description: 'padrão do Node' }],
          multi_select: false,
          answer: { labels: ['npm'] },
          suggested_count: 3,
          accepted_count: 2,
          created_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: 'CURSOR',
    };
    const r = decisionsResponse.safeParse(sample);
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });

  it('accepts a null next_cursor (last page)', () => {
    expect(decisionsResponse.safeParse({ decisions: [], next_cursor: null }).success).toBe(true);
  });
});

describe('tabQuestionSchema: suggestion', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  const choicePayload = { payload: { questions: [{ question: 'Q?', header: 'Q', multi_select: false, options: [{ label: 'a', description: '', recommended: true }] }] }, answer: null };

  it('parses a question carrying a suggestion', () => {
    const suggestion = {
      items: [
        {
          question_index: 0,
          decision_id: 'd1',
          similarity: 0.91,
          selected: [0],
          source: { question: 'Q antiga?', project_name: 'Projeto X', answered_at: '2026-09-20T00:00:00.000Z' },
        },
      ],
    };
    const r = tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, suggestion });
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });

  it('parses a question with a null suggestion, and one with no suggestion key at all (older servers)', () => {
    expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, suggestion: null }).success).toBe(true);
    expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload }).success).toBe(true);
  });
});
