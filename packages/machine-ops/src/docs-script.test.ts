/**
 * Runs the real scripts with `/bin/sh` against a temp dir, the same way the agent does — sh has
 * `sha256sum` and `base64` in the node:22 container these tests run in.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCS_MAX_BYTES, DOCS_MAX_FILES, buildDocsReadScript, buildDocsScanScript, parseDocsRead, parseDocsScan } from './docs-script.js';
import { shellQuote } from './shell.js';

let dir: string;

function write(rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function runScan(cwd: string): string {
  return execFileSync('/bin/sh', ['-c', buildDocsScanScript(shellQuote(cwd))], { encoding: 'utf8', timeout: 5000 });
}

function runRead(cwd: string, paths: string[]): string {
  return execFileSync('/bin/sh', ['-c', buildDocsReadScript(shellQuote(cwd), paths.map(shellQuote))], { encoding: 'utf8', timeout: 5000 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docs-script-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildDocsScanScript / parseDocsScan', () => {
  it('lists only docs/superpowers/{specs,plans}/*.md', () => {
    write('docs/superpowers/specs/a.md', 'A');
    write('docs/superpowers/plans/b.md', 'B');
    write('docs/other/x.md', 'nope');
    write('specs/sub/x.md', 'nope');
    write('docs/superpowers/specs/x.txt', 'nope');
    const { entries, err } = parseDocsScan(runScan(dir));
    expect(err).toBeNull();
    expect(entries.map((e) => e.path).sort()).toEqual(['docs/superpowers/plans/b.md', 'docs/superpowers/specs/a.md']);
  });

  it('reports a sha256 that matches Node crypto, and the byte size', () => {
    write('docs/superpowers/specs/a.md', 'hello world');
    const { entries } = parseDocsScan(runScan(dir));
    expect(entries).toEqual([
      { path: 'docs/superpowers/specs/a.md', sha256: createHash('sha256').update('hello world').digest('hex'), size: 11 },
    ]);
  });

  it('skips a symlink pointing outside the tree', () => {
    write('docs/superpowers/specs/real.md', 'x');
    const outside = join(tmpdir(), `docs-script-outside-${process.pid}.md`);
    writeFileSync(outside, 'y');
    symlinkSync(outside, join(dir, 'docs/superpowers/specs/link.md'));
    try {
      const { entries } = parseDocsScan(runScan(dir));
      expect(entries.map((e) => e.path)).toEqual(['docs/superpowers/specs/real.md']);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('lists a file over the size cap, with its size — docs.read is the one that skips it', () => {
    write('docs/superpowers/specs/big.md', 'x'.repeat(DOCS_MAX_BYTES + 10));
    const { entries } = parseDocsScan(runScan(dir));
    expect(entries).toEqual([{ path: 'docs/superpowers/specs/big.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), size: DOCS_MAX_BYTES + 10 }]);
  });

  it('caps at DOCS_MAX_FILES, taking the first by name', () => {
    const total = DOCS_MAX_FILES + 5;
    for (let i = 0; i < total; i++) write(`docs/superpowers/specs/f${String(i).padStart(4, '0')}.md`, 'x');
    const { entries } = parseDocsScan(runScan(dir));
    expect(entries).toHaveLength(DOCS_MAX_FILES);
    expect(entries[0]?.path).toBe('docs/superpowers/specs/f0000.md');
    expect(entries[entries.length - 1]?.path).toBe(`docs/superpowers/specs/f${String(DOCS_MAX_FILES - 1).padStart(4, '0')}.md`);
  });

  it('a missing docs/superpowers gives zero entries and no ERR', () => {
    const { entries, err } = parseDocsScan(runScan(dir));
    expect(entries).toEqual([]);
    expect(err).toBeNull();
  });

  it('a missing cwd gives ERR:notfound', () => {
    const { entries, err } = parseDocsScan(runScan(join(dir, 'does-not-exist')));
    expect(entries).toEqual([]);
    expect(err).toBe('notfound');
  });

  it('a filename with spaces is not listed', () => {
    write('docs/superpowers/specs/has space.md', 'x');
    const { entries } = parseDocsScan(runScan(dir));
    expect(entries).toEqual([]);
  });
});

describe('buildDocsReadScript / parseDocsRead', () => {
  it('round-trips UTF-8', () => {
    write('docs/superpowers/specs/a.md', 'ção');
    const map = parseDocsRead(runRead(dir, ['docs/superpowers/specs/a.md']));
    expect(map.get('docs/superpowers/specs/a.md')).toBe('ção');
  });

  it('reads several files from both directories in one call', () => {
    write('docs/superpowers/specs/a.md', 'A');
    write('docs/superpowers/plans/b.md', 'B');
    const map = parseDocsRead(runRead(dir, ['docs/superpowers/specs/a.md', 'docs/superpowers/plans/b.md']));
    expect(map.get('docs/superpowers/specs/a.md')).toBe('A');
    expect(map.get('docs/superpowers/plans/b.md')).toBe('B');
  });

  it('skips a file over DOCS_MAX_BYTES silently', () => {
    write('docs/superpowers/specs/big.md', 'x'.repeat(DOCS_MAX_BYTES + 1));
    const map = parseDocsRead(runRead(dir, ['docs/superpowers/specs/big.md']));
    expect(map.size).toBe(0);
  });

  it('re-validates the directory and character-class checks itself, defence in depth', () => {
    write('docs/other/x.md', 'nope');
    const map = parseDocsRead(runRead(dir, ['docs/other/x.md']));
    expect(map.size).toBe(0);
  });
});
