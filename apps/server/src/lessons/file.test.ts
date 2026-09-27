import { describe, expect, it } from 'vitest';
import { isLessonPath, parseLessonFile } from './file.js';

const md = `---
symptom: "P3009: migrate found failed migrations"
tags: [prisma, deploy]
evidence: fixed
card: TER-57
pr: https://github.com/engenhariainversa/termhub/pull/169
agent: claude
date: 2026-09-26
---
## Cause
The migration failed half-way in prod.

## Fix
prisma migrate resolve --rolled-back, then redeploy.
`;

describe('lesson files', () => {
  it('recognises lesson paths and skips the README', () => {
    expect(isLessonPath('docs/lessons/2026-09-26-p3009.md')).toBe(true);
    expect(isLessonPath('docs/lessons/README.md')).toBe(false);
    expect(isLessonPath('docs/lessons/sub/x.md')).toBe(false);
    expect(isLessonPath('docs/superpowers/specs/a.md')).toBe(false);
  });
  it('reads the front matter into meta and titles the lesson with the symptom', () => {
    const l = parseLessonFile('docs/lessons/2026-09-26-p3009.md', md);
    expect(l.title).toBe('P3009: migrate found failed migrations');
    expect(l.meta).toEqual({ evidence: 'fixed', card: 'TER-57', pr: 'https://github.com/engenhariainversa/termhub/pull/169', tags: ['prisma', 'deploy'], agent: 'claude', tab_id: null, origin: 'file', path: 'docs/lessons/2026-09-26-p3009.md' });
    expect(l.chunks.map((c) => c.text).join('\n')).toContain('migrate resolve');
    expect(l.chunks.every((c) => !c.text.includes('symptom:'))).toBe(true);
  });
  it('falls back to the path and default evidence without front matter, and caps values', () => {
    const l = parseLessonFile('docs/lessons/x.md', `## Fix\nDo it.\n`);
    expect(l.title).toBe('docs/lessons/x.md');
    expect(l.meta.evidence).toBe('observed');
    const long = parseLessonFile('docs/lessons/y.md', `---\nsymptom: ${'a'.repeat(400)}\ntags: [${Array.from({ length: 15 }, (_, i) => 't' + i).join(', ')}]\nevidence: bogus\n---\nx`);
    expect(long.title.length).toBe(300);
    expect(long.meta.tags).toHaveLength(10);
    expect(long.meta.evidence).toBe('observed');
  });
});
