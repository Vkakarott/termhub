import { describe, expect, it } from 'vitest';
import {
  chatMemoryPatchBody,
  chatMemoryResponse,
  decisionsResponse,
  isBoardGrantable,
  isTabGrantable,
  isTerminalGrantable,
  lessonForgetSchema,
  lessonItemSchema,
  lessonListSchema,
  mobileBatchDecisionBody,
  mobileDecisionBody,
  mobileMessageBody,
  notesResponse,
  STANDING_KIND_LABEL,
  standingKindOf,
  tabQuestionAutoAnswerCancelResponse,
} from './chat.js';
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

describe('mobileDecisionBody: approve_project', () => {
  it('approve_project always carries a proof', () => {
    expect(mobileDecisionBody.safeParse({ decision: 'approve_project' }).success).toBe(false);
    expect(mobileDecisionBody.safeParse({ decision: 'approve_project', challenge: 'c' }).success).toBe(false);
    expect(mobileDecisionBody.parse({ decision: 'approve_project', challenge: 'c', pin_proof: 'p' }).decision).toBe('approve_project');
  });
  it('batches never take approve_project', () => {
    expect(mobileBatchDecisionBody.safeParse({ decisions: [{ id: 'a', decision: 'approve_project', challenge: 'c', pin_proof: 'p' }] }).success).toBe(false);
  });
});

describe('mobileDecisionBody: terminal grants (TER-325)', () => {
  it.each(['approve_tab_terminal', 'approve_project_all'])('%s parses only with a challenge and a PIN proof', (decision) => {
    expect(mobileDecisionBody.safeParse({ decision }).success).toBe(false);
    expect(mobileDecisionBody.safeParse({ decision, challenge: 'c' }).success).toBe(false);
    expect(mobileDecisionBody.safeParse({ decision, pin_proof: 'p' }).success).toBe(false);
    expect(mobileDecisionBody.parse({ decision, challenge: 'c', pin_proof: 'p' }).decision).toBe(decision);
  });
  it.each(['approve_tab_terminal', 'approve_project_all'])('batches never take %s', (decision) => {
    expect(mobileBatchDecisionBody.safeParse({ decisions: [{ id: 'a', decision, challenge: 'c', pin_proof: 'p' }] }).success).toBe(false);
  });
});

describe('mobileDecisionBody: standing grant (TER-386)', () => {
  it('approve_project_always parses only with a challenge and a PIN proof', () => {
    expect(mobileDecisionBody.safeParse({ decision: 'approve_project_always' }).success).toBe(false);
    expect(mobileDecisionBody.safeParse({ decision: 'approve_project_always', challenge: 'c' }).success).toBe(false);
    expect(mobileDecisionBody.safeParse({ decision: 'approve_project_always', pin_proof: 'p' }).success).toBe(false);
    expect(mobileDecisionBody.parse({ decision: 'approve_project_always', challenge: 'c', pin_proof: 'p' }).decision).toBe('approve_project_always');
  });
  it('batches never take approve_project_always', () => {
    expect(mobileBatchDecisionBody.safeParse({ decisions: [{ id: 'a', decision: 'approve_project_always', challenge: 'c', pin_proof: 'p' }] }).success).toBe(false);
  });
});

describe('standingKindOf (client mirror of the server gate)', () => {
  it.each([
    ['open_tab with a project', { tool: 'open_tab', args: { project_id: 'p1' }, tab_id: null, project_id: 'p1' }, 'open_tab'],
    ['open_tab without a project', { tool: 'open_tab', args: {}, tab_id: null, project_id: null }, null],
    ['start_agent with a project', { tool: 'start_agent', args: { project_id: 'p1' }, tab_id: null, project_id: 'p1' }, 'start_agent'],
    ['start_agent without a project', { tool: 'start_agent', args: {}, tab_id: null, project_id: null }, null],
    ['close_tab with a tab', { tool: 'close_tab', args: { tab_id: 't1' }, tab_id: 't1', project_id: 'p1' }, 'close_tab'],
    ['close_tab without a tab', { tool: 'close_tab', args: {}, tab_id: null, project_id: 'p1' }, null],
    ['a board tool', { tool: 'move_task', args: { task_id: 'k1' }, tab_id: null, project_id: null }, 'board'],
    ['send_key to a tab', { tool: 'send_key', args: { tab_id: 't1', key: 'enter' }, tab_id: 't1', project_id: 'p1' }, 'terminal'],
    ['send_input answering a permission', { tool: 'send_input', args: { tab_id: 't1', text: '1', answering_permission: true }, tab_id: 't1', project_id: 'p1' }, null],
    ['delete_task', { tool: 'delete_task', args: { task_id: 'k1' }, tab_id: null, project_id: 'p1' }, null],
    ['run_command', { tool: 'run_command', args: { command: 'ls' }, tab_id: 't1', project_id: 'p1' }, null],
  ])('%s', (_name, action, kind) => {
    expect(standingKindOf(action)).toBe(kind);
  });
  it('has a pt-BR label for every kind', () => {
    expect(STANDING_KIND_LABEL).toEqual({ open_tab: 'abrir abas', close_tab: 'fechar abas paradas', start_agent: 'iniciar agentes', board: 'mexer no quadro', terminal: 'teclas e texto nas abas' });
  });
});

describe('isTerminalGrantable', () => {
  const base = { tool: 'send_key', args: { tab_id: 't1', key: 'enter' }, tab_id: 't1' };
  it('send_key or send_input to a tab, never answering a permission', () => {
    expect(isTerminalGrantable(base)).toBe(true);
    expect(isTerminalGrantable({ ...base, tool: 'send_input', args: { tab_id: 't1', text: 'oi' } })).toBe(true);
    expect(isTerminalGrantable({ ...base, tool: 'send_input', args: { tab_id: 't1', text: '1', answering_permission: true } })).toBe(false);
    expect(isTerminalGrantable({ ...base, args: { tab_id: 't1', key: 'enter', answering_permission: true } })).toBe(false);
    expect(isTerminalGrantable({ ...base, tab_id: null })).toBe(false);
    expect(isTerminalGrantable({ ...base, tool: 'run_command' })).toBe(false);
  });
});

describe('isBoardGrantable', () => {
  it('the four board tools only', () => {
    expect(['create_task', 'add_subtasks', 'update_task', 'move_task'].every((tool) => isBoardGrantable({ tool }))).toBe(true);
    expect(isBoardGrantable({ tool: 'delete_task' })).toBe(false);
    expect(isBoardGrantable({ tool: 'start_agent' })).toBe(false);
    expect(isBoardGrantable({ tool: 'send_input' })).toBe(false);
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

describe('tabQuestionSchema: auto answer (spec 2026-09-26 concierge memory §6)', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  const choicePayload = { payload: { questions: [{ question: 'Q?', header: 'Q', multi_select: false, options: [{ label: 'a', description: '', recommended: true }] }] }, answer: null };
  const auto = { answer: { answers: [{ selected: [0] }] }, by: 'memory', reason: 'Mesma pergunta respondida antes', sources: [{ kind: 'decision', id: 'd1' }], due_at: '2026-09-26T12:01:00.000Z', status: 'scheduled' };

  it('parses a card with a countdown and how it was answered', () => {
    const r = tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, auto_answer: auto, answered_via: null });
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
    expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, status: 'answered', answer: { answers: [{ selected: [0] }] }, auto_answer: { ...auto, status: 'sent' }, answered_via: 'auto' }).success).toBe(true);
  });

  it('parses a countdown with a status or author this build does not know yet (a newer server)', () => {
    const r = tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, auto_answer: { ...auto, by: 'someone_new', status: 'paused' } });
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });

  it('parses a card from an older server, with neither field', () => {
    expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload }).success).toBe(true);
  });

  it('the cancel response is the card, countdown cancelled', () => {
    const r = tabQuestionAutoAnswerCancelResponse.safeParse({ tab_question: { ...common, kind: 'choice', ...choicePayload, auto_answer: { ...auto, status: 'cancelled', decided_by: 'u1' }, answered_via: null } });
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });
});

describe('chatMemoryResponse (spec D8/D12)', () => {
  it('parses the switch, autodecide, availability, decisions count and notes count', () => {
    const r = chatMemoryResponse.safeParse({ enabled: true, autodecide: false, available: true, count: 3, notes: 1 });
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });
});

describe('chatMemoryPatchBody (spec D8/§8)', () => {
  it('accepts enabled alone, autodecide alone, or both', () => {
    expect(chatMemoryPatchBody.safeParse({ enabled: false }).success).toBe(true);
    expect(chatMemoryPatchBody.safeParse({ autodecide: true }).success).toBe(true);
    expect(chatMemoryPatchBody.safeParse({ enabled: true, autodecide: true }).success).toBe(true);
  });

  it('refuses an empty body: at least one of the two switches', () => {
    expect(chatMemoryPatchBody.safeParse({}).success).toBe(false);
  });
});

describe('notesResponse (spec D12/§8)', () => {
  it('parses a page of concierge notes with a next cursor', () => {
    const sample = {
      notes: [
        {
          id: 'n1',
          project_id: 'p1',
          project_name: 'Projeto X',
          question: 'Qual gerenciador de pacotes devo usar?',
          decision: 'npm',
          reason: 'é o padrão do Node',
          created_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: 'CURSOR',
    };
    const r = notesResponse.safeParse(sample);
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });

  it('accepts a null next_cursor (last page) and empty decision/reason', () => {
    expect(notesResponse.safeParse({ notes: [], next_cursor: null }).success).toBe(true);
    expect(
      notesResponse.safeParse({
        notes: [{ id: 'n1', project_id: null, project_name: null, question: 'Q', decision: '', reason: '', created_at: '2026-09-26T00:00:00.000Z' }],
        next_cursor: null,
      }).success,
    ).toBe(true);
  });
});

describe('lessonItemSchema/lessonListSchema (spec 2026-09-27 failure lessons §6/§8)', () => {
  const fileLesson = {
    id: 'l1',
    project: { id: 'p1', name: 'Projeto X' },
    title: 'P3009: migrate found failed migrations',
    excerpt: 'Cause…',
    origin: 'file' as const,
    path: 'docs/lessons/2026-09-27-p3009.md',
    tab_id: null,
    card: 'TER-57',
    pr: 'https://github.com/x/y/pull/169',
    evidence: 'fixed' as const,
    verified: true,
    verified_at: '2026-09-27T00:00:00.000Z',
    created_at: '2026-09-27T00:00:00.000Z',
  };
  const noteLesson = {
    id: 'l2',
    project: { id: 'p1', name: 'Projeto X' },
    title: 'Sintoma',
    excerpt: 'Causa…',
    origin: 'note' as const,
    path: null,
    tab_id: 't1',
    card: null,
    pr: null,
    evidence: 'observed' as const,
    verified: false,
    verified_at: null,
    created_at: '2026-09-27T00:00:00.000Z',
  };

  it('parses a file lesson and a note lesson', () => {
    expect(lessonItemSchema.safeParse(fileLesson).success).toBe(true);
    expect(lessonItemSchema.safeParse(noteLesson).success).toBe(true);
  });

  it('accepts a null project (an orphaned project)', () => {
    expect(lessonItemSchema.safeParse({ ...fileLesson, project: null }).success).toBe(true);
  });

  it('refuses an unknown origin or evidence value', () => {
    expect(lessonItemSchema.safeParse({ ...fileLesson, origin: 'other' }).success).toBe(false);
    expect(lessonItemSchema.safeParse({ ...fileLesson, evidence: 'maybe' }).success).toBe(false);
  });

  it('parses a page of lessons with a next cursor, and an empty last page', () => {
    expect(lessonListSchema.safeParse({ lessons: [fileLesson, noteLesson], next_cursor: 'CURSOR' }).success).toBe(true);
    expect(lessonListSchema.safeParse({ lessons: [], next_cursor: null }).success).toBe(true);
  });
});

describe('lessonForgetSchema (spec 2026-09-27 failure lessons §6)', () => {
  it('parses ok alone (a note lesson) and ok with a note (a file lesson)', () => {
    expect(lessonForgetSchema.safeParse({ ok: true }).success).toBe(true);
    expect(lessonForgetSchema.safeParse({ ok: true, note: 'O arquivo continua no repositório; apague-o por um PR para sumir de vez' }).success).toBe(true);
  });

  it('refuses ok: false', () => {
    expect(lessonForgetSchema.safeParse({ ok: false }).success).toBe(false);
  });
});
