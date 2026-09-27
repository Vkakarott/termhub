import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatActionSchema, chatEventSchema, chatGrantListItemSchema, chatGrantListQuery, chatGrantListResponse, subagentViewSchema, tabQuestionSchema, tabSuggestionSchema } from './events.js';

const base = { user_id: 'u1', conversation_id: 'c1' };
const grant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', tab_name: 'api' };
const card = { id: 'a2', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'executed', machine_id: null, project_id: null, tab_id: 't1', grant_id: 'g1', summary: 'digitar `oi` na aba api', created_at: '2026-09-25T10:01:00.000Z' };

describe('chatEventSchema: grants', () => {
  it.each([
    ['grant', { type: 'grant', ...base, grant }],
    ['grant_revoked', { type: 'grant_revoked', ...base, grant_id: 'g1' }],
    ['granted_action', { type: 'granted_action', ...base, action: card }],
  ])('accepts %s', (_t, e) => {
    const r = chatEventSchema.safeParse(e);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('parses project_grant and project_grant_revoked', () => {
    const pg = { id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: '2026-09-27T10:00:00.000Z', expires_at: '2026-09-28T10:00:00.000Z' };
    expect(chatEventSchema.parse({ type: 'project_grant', ...base, grant: pg }).type).toBe('project_grant');
    expect(chatEventSchema.parse({ type: 'project_grant', ...base, grant: { ...pg, project_name: null, source_action_id: null } }).type).toBe('project_grant');
    expect(chatEventSchema.parse({ type: 'project_grant_revoked', ...base, grant_id: 'pg1' }).type).toBe('project_grant_revoked');
  });
  it('keeps grant_id on the card', () => {
    const r = chatEventSchema.parse({ type: 'granted_action', ...base, action: card });
    expect(r.type === 'granted_action' && r.action.grant_id).toBe('g1');
  });
});

// The card's origin (spec 2026-09-26 §4): which subagent's turn proposed the action. Optional and
// nullable on both `chatActionSchema` and the `confirmation` event, so an older server (neither field
// nor value) and a current one saying "no subagent" both still parse.
describe('chatActionSchema / confirmation: subagent', () => {
  const subagent = { id: 'sub1', description: 'Escrever testes' };
  it.each([
    ['with a subagent', { ...card, subagent }],
    ['with no subagent (null)', { ...card, subagent: null }],
    ['without the field at all (an older server)', card],
  ])('accepts a card %s', (_label, c) => {
    const r = chatActionSchema.safeParse(c);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('parses the subagent through to the card', () => {
    expect(chatActionSchema.parse({ ...card, subagent }).subagent).toEqual(subagent);
  });

  const confirmation = { type: 'confirmation', ...base, action_id: 'a1', tool: 'run_command', args: { command: 'ls' }, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'Rodar ls', created_at: '2026-09-24T12:00:00.000Z' };
  it.each([
    ['with a subagent', { ...confirmation, subagent }],
    ['with no subagent (null)', { ...confirmation, subagent: null }],
    ['without the field at all (an older server)', confirmation],
  ])('accepts a confirmation %s', (_label, e) => {
    const r = chatEventSchema.safeParse(e);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});

it('parses both kinds of tab question and refuses a payload of the other kind', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', payload: { questions: [{ question: 'Q?', header: 'Q', multi_select: false, options: [{ label: 'a', description: '', recommended: true }] }] }, answer: null }).success).toBe(true);
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { tool_name: 'Bash' }, answer: { allow: false, text: 'não' } }).success).toBe(true);
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { questions: [] }, answer: null }).success).toBe(false);
});

it('parses a tab suggestion and its two events; refuses a question on them', () => {
  const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabSuggestionSchema.safeParse(s).success).toBe(true);
  expect(tabSuggestionSchema.safeParse({ ...s, status: 'dismissed', closed_at: '2026-09-25T12:01:00.000Z' }).success).toBe(true);
  expect(tabSuggestionSchema.safeParse({ ...s, kind: 'permission', payload: { tool_name: 'Bash' } }).success).toBe(false);
  expect(chatEventSchema.safeParse({ type: 'tab_suggestion', ...base, suggestion: s }).success).toBe(true);
  expect(chatEventSchema.safeParse({ type: 'tab_suggestion_closed', ...base, suggestion: { ...s, status: 'answered', answer: { text: 'commit it' } } }).success).toBe(true);
});

it('a tab question never carries the dismissed status: that value is the suggestions\' own', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'dismissed' }).success).toBe(false);
});

it('a tab question suggestion item may carry the concierge fields (by/reason/sources); an older app still parses without them (concierge memory spec 2026-09-26 §5.4)', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-09-26T12:00:00.000Z', answered_at: null, closed_at: null };
  const choicePayload = { payload: { questions: [{ question: 'Q?', header: 'Q', multi_select: false, options: [{ label: 'a', description: '', recommended: false }] }] }, answer: null };
  const conciergeItem = {
    question_index: 0,
    decision_id: '',
    similarity: 0,
    selected: [0],
    by: 'concierge',
    reason: 'Você sempre faz assim',
    sources: ['doc:i1'],
    source: { question: 'Q?', project_name: null, answered_at: '2026-09-20T10:00:00.000Z' },
  };
  const r = tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, suggestion: { items: [conciergeItem] } });
  expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  expect(r.success && r.data.suggestion?.items[0]).toMatchObject({ by: 'concierge', reason: 'Você sempre faz assim', sources: ['doc:i1'] });
  // Without them at all: still parses (an older server never sends them, a memory-backed suggestion).
  const { by: _by, reason: _reason, sources: _sources, ...plain } = conciergeItem;
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, suggestion: { items: [plain] } }).success).toBe(true);
});

describe('chat grant list', () => {
  const item = {
    id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: null, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z',
    tab_name: null, project_id: null, project_name: null, conversation_id: 'c1', conversation_project_name: null, conversation_archived: false,
    state: 'expired', ended_at: '2026-09-26T10:00:00.000Z',
  };
  it('parses the server list shape', () => {
    expect(chatGrantListResponse.parse({ grants: [item], next_cursor: null }).grants[0]!.state).toBe('expired');
    expect(chatGrantListResponse.safeParse({ grants: [{ ...item, state: 'gone' }], next_cursor: null }).success).toBe(false);
  });
  it('validates the query: state required, limit 1..100 defaulting to 50', () => {
    expect(chatGrantListQuery.parse({ state: 'ended' })).toEqual({ state: 'ended', limit: 50, kinds: 'tab' });
    expect(chatGrantListQuery.parse({ state: 'active', limit: '10', cursor: 'abc' })).toEqual({ state: 'active', limit: 10, cursor: 'abc', kinds: 'tab' });
    for (const bad of [{}, { state: 'all' }, { state: 'ended', limit: '0' }, { state: 'ended', limit: '101' }, { state: 'ended', cursor: '' }]) expect(chatGrantListQuery.safeParse(bad).success).toBe(false);
  });

  it('list items: kind defaults to tab, a project row has no tab', () => {
    const tabRow = { ...grant, project_id: 'p1', project_name: 'App', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false, state: 'active', ended_at: null };
    expect(chatGrantListItemSchema.parse(tabRow).kind).toBe('tab');
    expect(chatGrantListItemSchema.parse({ ...tabRow, kind: 'project', tab_id: null, tab_name: null, tool: null }).kind).toBe('project');
    expect(chatGrantListQuery.parse({ state: 'active' }).kinds).toBe('tab');
  });
});

it('a suggestion may carry the message it answers; an app and a server that predate it both still parse (spec 2026-09-26 §6.3)', () => {
  const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-26T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabSuggestionSchema.parse({ ...s, payload: { text: 'commit it', context: 'Quer que eu faça o commit?' } }).payload.context).toBe('Quer que eu faça o commit?');
  expect(tabSuggestionSchema.safeParse({ ...s, payload: { text: 'commit it', context: null } }).success).toBe(true);
  expect(tabSuggestionSchema.parse(s).payload.context).toBeUndefined(); // a server before TER-96
  // The schema an app before TER-96 shipped: a plain z.object strips the new field instead of refusing it.
  const before = tabSuggestionSchema.extend({ payload: z.object({ text: z.string() }) });
  expect(before.parse({ ...s, payload: { text: 'commit it', context: 'x' } }).payload).toEqual({ text: 'commit it' });
});

it('parses attachment_status, and a message that carries attachments', () => {
  const attachment = { id: 'at1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 1234, status: 'ready', error_code: null, meta: { pages: 12 }, created_at: '2026-09-26T12:00:00.000Z' };
  expect(chatEventSchema.safeParse({ type: 'attachment_status', ...base, attachment }).success).toBe(true);
  const message = { id: 'm1', conversation_id: 'c1', role: 'user', text: '', usage: null, error_code: null, created_at: '2026-09-26T12:00:00.000Z', attachments: [attachment] };
  expect(chatEventSchema.safeParse({ type: 'message', ...base, message }).success).toBe(true);
  expect(chatEventSchema.safeParse({ type: 'attachment_status', ...base, attachment: { ...attachment, kind: 'exe' } }).success).toBe(false);
});

// The subagents panel (spec 2026-09-26 panel §4): a row per subagent, and the failed-cancel notice.
describe('chatEventSchema: subagents', () => {
  const subagent = { id: 'sub1', description: 'Buscar CI', subagent_type: null, status: 'running', started_at: '2026-09-26T12:00:00.000Z', ended_at: null };
  it.each([
    ['subagent', { type: 'subagent', ...base, subagent }],
    ['subagent (ended)', { type: 'subagent', ...base, subagent: { ...subagent, subagent_type: 'general-purpose', status: 'interrupted', ended_at: '2026-09-26T12:04:00.000Z' } }],
    ['subagent_cancel_failed', { type: 'subagent_cancel_failed', ...base, subagent_id: 'sub1' }],
  ])('accepts %s', (_t, e) => {
    const r = chatEventSchema.safeParse(e);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('refuses a status the server never sends', () => {
    expect(subagentViewSchema.safeParse({ ...subagent, status: 'paused' }).success).toBe(false);
  });
  it('requires the subagent id on a failed cancel', () => {
    expect(chatEventSchema.safeParse({ type: 'subagent_cancel_failed', ...base }).success).toBe(false);
  });
});
