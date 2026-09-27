import { describe, expect, it } from 'vitest';
import { resumeNote } from './resume.js';

describe('resumeNote', () => {
  it('names the interrupted subagents and the messages that follow', () => {
    const t = resumeNote(['Buscar CI', 'Abrir aba'], 2);
    expect(t).toContain('O servidor do termhub reiniciou');
    expect(t).toContain('«Buscar CI»');
    expect(t).toContain('«Abrir aba»');
    expect(t).toContain('2 mensagens');
  });

  it('says nothing about subagents when none were running', () => {
    expect(resumeNote([], 1)).not.toContain('subagente');
  });

  it('says nothing about messages when none were open', () => {
    expect(resumeNote(['Buscar CI'], 0)).not.toContain('mensage');
  });
});
