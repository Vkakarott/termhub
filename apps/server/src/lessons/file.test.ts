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

  it('parses the repo README and example lesson front matter, and the README is skipped by isLessonPath', async () => {
    const { readFileSync } = await import('node:fs');
    expect(isLessonPath('docs/lessons/README.md')).toBe(false);

    const readme = readFileSync(new URL('../../../../docs/lessons/README.md', import.meta.url), 'utf8');
    const parsedReadme = parseLessonFile('docs/lessons/README.md', readme);
    // no front matter in the README: falls back to the path, default evidence, no crash
    expect(parsedReadme.title).toBe('docs/lessons/README.md');
    expect(parsedReadme.meta.evidence).toBe('observed');

    const example = readFileSync(new URL('../../../../docs/lessons/2026-09-26-p3009-failed-migration.md', import.meta.url), 'utf8');
    const parsedExample = parseLessonFile('docs/lessons/2026-09-26-p3009-failed-migration.md', example);
    expect(parsedExample.meta).toEqual({
      evidence: 'fixed', card: 'TER-57', pr: null, tags: ['prisma', 'deploy'], agent: 'claude', tab_id: null, origin: 'file',
      path: 'docs/lessons/2026-09-26-p3009-failed-migration.md',
    });
    expect(parsedExample.title).toMatch(/P3009/);
    expect(parsedExample.chunks.map((c) => c.text).join('\n')).toMatch(/migrate resolve --rolled-back/);
  });
});
