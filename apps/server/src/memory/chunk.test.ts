import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from './chunk.js';

describe('chunkMarkdown', () => {
  it('splits on headings and titles each chunk with the path and heading', () => {
    const md = '# Spec\nIntro.\n\n## Decisões\nUsar worktree.\n\n### D1\nDetalhe.';
    expect(chunkMarkdown('docs/superpowers/specs/a.md', md)).toEqual([
      { index: 0, title: 'docs/superpowers/specs/a.md › Spec', text: 'Intro.' },
      { index: 1, title: 'docs/superpowers/specs/a.md › Decisões', text: 'Usar worktree.' },
      { index: 2, title: 'docs/superpowers/specs/a.md › D1', text: 'Detalhe.' },
    ]);
  });
  it('packs paragraphs up to max and cuts a longer paragraph', () => {
    const para = 'x'.repeat(700);
    const chunks = chunkMarkdown('a.md', `# T\n${para}\n\n${para}\n\n${'y'.repeat(2500)}`, 1200);
    expect(chunks.map((c) => c.text.length)).toEqual([700, 700, 1200, 1200, 100]);
    expect(chunks.every((c) => c.title === 'a.md › T')).toBe(true);
  });
  it('ignores a heading-looking line inside a code fence', () => {
    const md = '# T\n```\n# not a heading\n```\nafter';
    expect(chunkMarkdown('a.md', md)).toHaveLength(1);
  });
  it('gives text before the first heading the path alone as title, and drops empty sections', () => {
    expect(chunkMarkdown('a.md', 'lead\n\n# Empty\n\n# Full\nbody')).toEqual([
      { index: 0, title: 'a.md', text: 'lead' },
      { index: 1, title: 'a.md › Full', text: 'body' },
    ]);
  });
});
