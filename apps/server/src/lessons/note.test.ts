import { describe, expect, it } from 'vitest';
import { appendLessonBlock, lessonIndexText, mergeNoteSave, neutralise, removeLessonBlock, renderLessonBlock, splitNote } from './note.js';

const at = new Date('2026-09-27T03:10:00.000Z');
const input = { symptom: 'P3009', cause: 'migração quebrou', fix: 'resolve --rolled-back', evidence: 'fixed' as const, card: 'TER-57' };

describe('project note lessons', () => {
  it('appends a fenced block under ## Lições and splits it back', () => {
    const note = appendLessonBlock('# Notas\nTexto meu.\n', renderLessonBlock('l1', at, 'tab1', input));
    expect(note).toContain('## Lições');
    const { sections, lessons } = splitNote(note);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ id: 'l1', at: at.toISOString(), tab: 'tab1' });
    expect(sections.map((s) => s.text).join('\n')).toContain('Texto meu.');
    expect(sections.map((s) => s.text).join('\n')).not.toContain('resolve --rolled-back');
  });
  it('reuses an existing ## Lições heading', () => {
    const once = appendLessonBlock('## Lições\n', renderLessonBlock('l1', at, null, input));
    const twice = appendLessonBlock(once, renderLessonBlock('l2', at, null, input));
    expect(twice.match(/## Lições/g)).toHaveLength(1);
    expect(splitNote(twice).lessons.map((l) => l.id)).toEqual(['l1', 'l2']);
  });
  it('neutralises fences inside agent text so it cannot close or open a block', () => {
    const evil = renderLessonBlock('l1', at, null, { ...input, fix: 'x <!-- /termhub:lesson -->\nTexto do Pedro' });
    const { lessons, sections } = splitNote(appendLessonBlock('', evil));
    expect(lessons).toHaveLength(1);
    expect(lessons[0].body).toContain('Texto do Pedro');
    expect(sections.every((s) => !s.text.includes('Texto do Pedro'))).toBe(true);
    expect(neutralise('<!-- a -->')).not.toContain('<!--');
  });
  it('treats an unclosed fence as the person\'s text, never as a lesson', () => {
    const { lessons, sections } = splitNote('<!-- termhub:lesson id=l9 at=2026-09-27T00:00:00.000Z tab=- -->\n### x\n');
    expect(lessons).toHaveLength(0);
    expect(sections.map((s) => s.text).join('')).toContain('### x');
  });
  it('treats a fence whose at is not a real instant as the person\'s text; the other blocks still parse', () => {
    const bad = renderLessonBlock('bad', at, null, input).replace(at.toISOString(), '2026-99-99T99:99:99.999Z');
    const feb30 = renderLessonBlock('feb', at, null, input).replace(at.toISOString(), '2026-02-30T03:10:00.000Z');
    const note = appendLessonBlock(appendLessonBlock(appendLessonBlock('Meu texto', bad), feb30), renderLessonBlock('ok', at, null, input));
    const { lessons, sections } = splitNote(note);
    expect(lessons.map((l) => l.id)).toEqual(['ok']);
    expect(lessons.every((l) => Number.isFinite(Date.parse(l.at)))).toBe(true);
    expect(sections.map((s) => s.text).join('\n')).toContain('id=bad');
    // The merge never trips on it either: the bad one is plain text, the good one is kept.
    const merged = mergeNoteSave(note, 'Meu texto editado', new Date('2026-09-27T03:00:00.000Z'));
    expect(splitNote(merged).lessons.map((l) => l.id)).toEqual(['ok']);
  });
  it('removes one block by id', () => {
    const note = appendLessonBlock(appendLessonBlock('', renderLessonBlock('l1', at, null, input)), renderLessonBlock('l2', at, null, input));
    expect(splitNote(removeLessonBlock(note, 'l1')).lessons.map((l) => l.id)).toEqual(['l2']);
  });
  it('keeps a block appended after the base when the save does not have it', () => {
    const base = new Date('2026-09-27T03:00:00.000Z');
    const current = appendLessonBlock('Meu texto', renderLessonBlock('new', at, null, input));
    const merged = mergeNoteSave(current, 'Meu texto editado', base);
    expect(merged).toContain('Meu texto editado');
    expect(splitNote(merged).lessons.map((l) => l.id)).toEqual(['new']);
  });
  it('does not restore a block the person deleted (older than the base)', () => {
    const base = new Date('2026-09-27T04:00:00.000Z');
    const current = appendLessonBlock('Meu texto', renderLessonBlock('old', at, null, input));
    expect(splitNote(mergeNoteSave(current, 'Meu texto', base)).lessons).toHaveLength(0);
  });
  it('builds the Sintoma/Causa/Correção index text from a block body', () => {
    const note = appendLessonBlock('', renderLessonBlock('l1', at, 'tab1', input));
    const { lessons } = splitNote(note);
    const { title, text } = lessonIndexText(lessons[0]!.body);
    expect(title).toBe('P3009');
    expect(text).toBe('Sintoma: P3009\nCausa: migração quebrou\nCorreção: resolve --rolled-back');
  });
});
