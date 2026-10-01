import { describe, expect, it } from 'vitest';
import type { TabSuggestion } from '../../lib/types';
import { CONTEXT_PREVIEW_MAX, isReplyCard, lastParagraph, suggestionFieldLabel, suggestionHint, suggestionTitle } from './tab-suggestion-text';

const s = (over: Partial<TabSuggestion> = {}): TabSuggestion => ({ id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null, ...over });

describe('lastParagraph (spec 2026-09-26 §6.4)', () => {
  it('is the text after the last blank line', () => {
    expect(lastParagraph('Criei o arquivo.\n\nRodei os testes.\n  \nQuer que eu faça o commit?', 400)).toBe('Quer que eu faça o commit?');
  });
  it('is the whole text when it has one paragraph', () => {
    expect(lastParagraph('  Quer seguir?\nOu paro aqui?  ', 400)).toBe('Quer seguir?\nOu paro aqui?');
  });
  it('keeps the end of a long paragraph, marked with …, within max', () => {
    const out = lastParagraph(`${'a'.repeat(500)} fim?`, 400);
    expect(out).toHaveLength(400);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith(' fim?')).toBe(true);
  });
  it('never starts on half a surrogate pair', () => {
    expect(/^…(?:😀)+$/u.test(lastParagraph('😀'.repeat(300), 400))).toBe(true);
  });
  it('previews 400 characters', () => {
    expect(CONTEXT_PREVIEW_MAX).toBe(400);
  });
});

describe('suggestionTitle', () => {
  it('offers the suggestion while open (it asks nothing), and says what the tab suggested once closed', () => {
    expect(suggestionTitle(s())).toBe('«api» terminou — o Claude Code sugere:');
    expect(suggestionTitle(s({ tab_name: null }))).toBe('Uma aba terminou — o Claude Code sugere:');
    expect(suggestionTitle(s({ status: 'answered' }))).toBe('«api» sugere:');
    expect(suggestionTitle(s({ status: 'dismissed', tab_name: null }))).toBe('Uma aba sugere:');
  });
});

describe('a Codex reply card', () => {
  const codex = (over: Partial<TabSuggestion> = {}) => s({ payload: { text: '', context: 'Quer que eu siga?', agent: 'codex' }, ...over });
  it('says the Codex asked, open; once answered from the chat, that the person answered', () => {
    expect(suggestionTitle(codex())).toBe('«api» terminou — o Codex perguntou:');
    expect(suggestionTitle(codex({ tab_name: null }))).toBe('Uma aba terminou — o Codex perguntou:');
    expect(suggestionTitle(codex({ status: 'answered' }))).toBe('«api» perguntou; você respondeu:');
    expect(suggestionTitle(codex({ status: 'answered', tab_name: null }))).toBe('Uma aba perguntou; você respondeu:');
    expect(suggestionTitle(codex({ status: 'failed' }))).toBe('«api» perguntou; você respondeu:');
  });
  it('a Codex question closed without a chat answer says only that it asked', () => {
    for (const status of ['dismissed', 'answered_in_tab', 'expired'] as const) {
      expect(suggestionTitle(codex({ status }))).toBe('«api» perguntou:');
      expect(suggestionTitle(codex({ status, tab_name: null }))).toBe('Uma aba perguntou:');
    }
  });
  it('asks for an answer instead of saying none is needed', () => {
    expect(suggestionHint(codex())).toBe('Responda aqui ou na aba.');
    expect(suggestionHint(s())).toBe('Não precisa responder.');
  });
});

describe('a resume card (TER-643)', () => {
  const exited = (over: Partial<TabSuggestion> = {}) => s({ payload: { text: 'claude --continue', exited: true, last_at: null }, ...over } as Partial<TabSuggestion>);
  it('says the agent exited and offers the line', () => {
    expect(suggestionTitle(exited())).toBe('«api» parou: o agente encerrou sem terminar o turno.');
    expect(suggestionTitle(exited({ tab_name: null }))).toBe('Uma aba parou: o agente encerrou sem terminar o turno.');
    expect(suggestionTitle(exited({ status: 'answered' }))).toBe('«api» parou; comando para retomar:');
    expect(suggestionHint(exited())).toBe('Envie o comando para retomar a sessão na aba, ou dispense.');
    expect(suggestionFieldLabel(exited())).toBe('Comando para retomar (edite ou dispense)');
  });
  it('names the last activity in local time', () => {
    const at = new Date(2026, 9, 1, 2, 48);
    expect(suggestionHint(exited({ payload: { text: 'x', exited: true, last_at: at.toISOString() } } as Partial<TabSuggestion>))).toBe('Última atividade às 02:48. Envie o comando para retomar a sessão na aba, ou dispense.');
  });
  it('a Codex resume card holds a line to edit, not a reply', () => {
    expect(isReplyCard(exited({ payload: { text: 'codex resume --last', agent: 'codex', exited: true } } as Partial<TabSuggestion>))).toBe(false);
    expect(isReplyCard(s({ payload: { text: '', agent: 'codex' } } as Partial<TabSuggestion>))).toBe(true);
    expect(suggestionFieldLabel(s())).toBe('Sugestão do Claude Code (opcional — edite ou dispense)');
  });
});
