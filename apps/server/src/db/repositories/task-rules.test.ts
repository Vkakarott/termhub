import { describe, expect, it } from 'vitest';
import { checkSubtaskParent, checkTypeChange, parseRef, TaskRuleError } from './task-rules.js';

describe('TaskRuleError', () => {
  it('carries the pt-BR message of its code by default, or the one given', () => {
    expect(new TaskRuleError('EPIC_REQUIRED').message).toBe('Escolha um épico');
    expect(new TaskRuleError('COLUMN_LAST_OF_CATEGORY').message).toBe('O board precisa de ao menos uma coluna de cada tipo');
    expect(new TaskRuleError('TOO_MANY_COLUMNS').message).toBe('Limite de 12 colunas');
    expect(new TaskRuleError('PARENT_IS_SUBTASK', 'custom').message).toBe('custom');
    expect(new TaskRuleError('HAS_SUBTASKS').code).toBe('HAS_SUBTASKS');
  });
});

describe('checkTypeChange', () => {
  it('allows any change among story, task, bug and spike', () => {
    for (const [from, to] of [['story', 'task'], ['task', 'bug'], ['bug', 'spike'], ['spike', 'story']] as const) {
      expect(() => checkTypeChange(from, to, 0)).not.toThrow();
    }
  });
  it('keeps a card with subtasks a story or a task', () => {
    expect(() => checkTypeChange('story', 'task', 3)).not.toThrow();
    expect(() => checkTypeChange('task', 'bug', 1)).toThrow(expect.objectContaining({ code: 'HAS_SUBTASKS', message: 'Tire as subtarefas antes de mudar para bug ou spike' }));
    expect(() => checkTypeChange('story', 'spike', 1)).toThrow(expect.objectContaining({ code: 'HAS_SUBTASKS' }));
  });
  it('never changes an epic or a subtask, nor turns anything into one', () => {
    for (const [from, to] of [['epic', 'task'], ['subtask', 'task'], ['task', 'epic'], ['story', 'subtask']] as const) {
      expect(() => checkTypeChange(from, to, 0)).toThrow(expect.objectContaining({ code: 'TYPE_LOCKED', message: 'Épico e subtarefa não mudam de tipo' }));
    }
  });
  it('accepts no change at all', () => {
    expect(() => checkTypeChange('epic', 'epic', 0)).not.toThrow();
  });
});

describe('checkSubtaskParent', () => {
  it('accepts a story or a task', () => {
    expect(() => checkSubtaskParent({ type: 'story', parentId: null })).not.toThrow();
    expect(() => checkSubtaskParent({ type: 'task', parentId: null })).not.toThrow();
  });
  it('refuses a subtask (or any row with a parent) as parent', () => {
    expect(() => checkSubtaskParent({ type: 'subtask', parentId: 'x' })).toThrow(expect.objectContaining({ code: 'PARENT_IS_SUBTASK' }));
    expect(() => checkSubtaskParent({ type: 'task', parentId: 'x' })).toThrow(expect.objectContaining({ code: 'PARENT_IS_SUBTASK' }));
  });
  it('refuses an epic, a bug and a spike', () => {
    for (const type of ['epic', 'bug', 'spike'] as const) {
      expect(() => checkSubtaskParent({ type, parentId: null })).toThrow(expect.objectContaining({ code: 'PARENT_TYPE', message: 'Subtarefa só pode ficar em uma história ou tarefa' }));
    }
  });
});

describe('parseRef', () => {
  it('splits KEY-N, uppercasing the key and ignoring surrounding spaces', () => {
    expect(parseRef('TER-12')).toEqual({ key: 'TER', number: 12 });
    expect(parseRef(' ter-7 ')).toEqual({ key: 'TER', number: 7 });
    expect(parseRef('A1B2-1')).toEqual({ key: 'A1B2', number: 1 });
  });
  it.each(['TER', 'TER-', 'TER-0', 'TER-01', '1AB-2', 'T-1', 'TER-12-3', 'TER 12', 'ABCDEFGHIJK-1', 'TER-1234567890'])('rejects %j', (ref) => {
    expect(parseRef(ref)).toBeNull();
  });
});
