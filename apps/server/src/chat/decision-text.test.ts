import { describe, expect, it } from 'vitest';
import { answerToDecision, decisionText, embedTag, embedText, EMBED_TEXT_VERSION, labelKey, mapAnswer, sameAnswer } from './decision-text.js';

const item = (labels: string[], multi = false) => ({ question: 'Usar worktree?', header: 'Isolamento', multi_select: multi, options: labels.map((label) => ({ label, description: 'longa descrição', recommended: false })) });

describe('decisionText', () => {
  it('header, question and option labels — never descriptions', () => {
    expect(decisionText(item(['Sim', 'Não']))).toBe('Isolamento\nUsar worktree?\nOpções: Sim | Não');
  });
});

describe('labelKey', () => {
  it('ignores case, accents, spaces and punctuation', () => {
    expect(labelKey('  Não, obrigado! ')).toBe(labelKey('nao obrigado'));
  });
});

describe('answerToDecision', () => {
  it('stores labels, not indexes', () => {
    expect(answerToDecision(item(['A', 'B', 'C'], true), { selected: [0, 2] })).toEqual({ labels: ['A', 'C'] });
  });
  it('stores free text as text', () => {
    expect(answerToDecision(item(['A', 'B']), { selected: [], text: 'outra' })).toEqual({ labels: [], text: 'outra' });
  });
});

describe('mapAnswer', () => {
  it('maps labels onto the new options, whatever their order and case', () => {
    expect(mapAnswer({ labels: ['sim'] }, item(['Não', 'Sim']))).toEqual({ selected: [1] });
  });
  it('maps a multi-select answer to sorted indexes', () => {
    expect(mapAnswer({ labels: ['C', 'A'] }, item(['A', 'B', 'C'], true))).toEqual({ selected: [0, 2] });
  });
  it('a label that no longer exists maps to nothing', () => {
    expect(mapAnswer({ labels: ['Talvez'] }, item(['Sim', 'Não']))).toBeNull();
  });
  it('a single-select never gets two labels', () => {
    expect(mapAnswer({ labels: ['Sim', 'Não'] }, item(['Sim', 'Não']))).toBeNull();
  });
  it('free text maps as text', () => {
    expect(mapAnswer({ labels: [], text: 'usar a main' }, item(['Sim', 'Não']))).toEqual({ selected: [], text: 'usar a main' });
  });
  it('labels win over text: the card sends one or the other, so a mix could never count as accepted', () => {
    const mapped = mapAnswer({ labels: ['Sim'], text: 'e também isto' }, item(['Sim', 'Não']));
    expect(mapped).toStrictEqual({ selected: [0] });
  });
  it('an empty answer maps to nothing', () => {
    expect(mapAnswer({ labels: [] }, item(['Sim', 'Não']))).toBeNull();
  });
});

describe('sameAnswer', () => {
  it('compares selections as sets and text trimmed', () => {
    expect(sameAnswer({ selected: [2, 0] }, { selected: [0, 2] })).toBe(true);
    expect(sameAnswer({ selected: [], text: ' a ' }, { selected: [], text: 'a' })).toBe(true);
    expect(sameAnswer({ selected: [0] }, { selected: [1] })).toBe(false);
  });
});

describe('embedText', () => {
  it('is the question alone, lower-cased, without trailing punctuation', () => {
    expect(embedText({ question: 'Usar git worktree para isolar o trabalho?' })).toBe('usar git worktree para isolar o trabalho');
  });
  it('ignores header and options, so a changed header or reordered options embed the same', () => {
    const a = { header: 'Isolamento', question: 'Usar worktree?', options: [{ label: 'Sim' }, { label: 'Não' }] };
    const b = { header: 'Git', question: 'Usar worktree?', options: [{ label: 'Não' }, { label: 'Sim' }, { label: 'Talvez' }] };
    expect(embedText(a)).toBe(embedText(b));
  });
  it('collapses whitespace and strips every trailing ?!.:; plus surrounding spaces', () => {
    expect(embedText({ question: '  Fazer   commit\n agora ?! ' })).toBe('fazer commit agora');
    expect(embedText({ question: 'Pronto.' })).toBe('pronto');
  });
  it('keeps inner punctuation and accents', () => {
    expect(embedText({ question: 'Salvar em docs/plans, ou não?' })).toBe('salvar em docs/plans, ou não');
  });
  it('gives an empty string for a question that is only punctuation', () => {
    expect(embedText({ question: ' ?! ' })).toBe('');
  });
});

describe('embedTag', () => {
  it('appends the text version to the model name', () => {
    expect(EMBED_TEXT_VERSION).toBe('q1');
    expect(embedTag('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')).toBe('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2#q1');
  });
});
