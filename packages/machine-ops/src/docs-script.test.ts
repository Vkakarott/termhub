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
import { DOCS_MAX_BYTES, DOCS_MAX_FILES, DOCS_READ_MAX_BYTES, buildDocsReadScript, buildDocsScanScript, parseDocsRead, parseDocsScan } from './docs-script.js';
import { shellQuote } from './shell.js';

// Mirrors @termhub/agent-protocol's MAX_FRAME (frames.ts) without depending on that package —
// docs.read's whole result travels as one WebSocket control frame, which the server refuses above this.
const MAX_FRAME = 1024 * 1024;

let dir: string;

function write(rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function runScan(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('/bin/sh', ['-c', buildDocsScanScript(shellQuote(cwd))], { encoding: 'utf8', timeout: 20_000, env });
}

function runRead(cwd: string, paths: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('/bin/sh', ['-c', buildDocsReadScript(shellQuote(cwd), paths.map(shellQuote))], { encoding: 'utf8', timeout: 20_000, env });
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

  it('skips a symlinked file pointing outside the tree', () => {
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

  it('lists a file over the size cap as an S line, with its size but no hash — docs.read is the one that skips it', () => {
    write('docs/superpowers/specs/big.md', 'x'.repeat(DOCS_MAX_BYTES + 10));
    const { entries } = parseDocsScan(runScan(dir));
    expect(entries).toEqual([{ path: 'docs/superpowers/specs/big.md', sha256: null, size: DOCS_MAX_BYTES + 10 }]);
  });

  it(
    'caps at DOCS_MAX_FILES, taking the first by name',
    () => {
      const total = DOCS_MAX_FILES + 5;
      for (let i = 0; i < total; i++) write(`docs/superpowers/specs/f${String(i).padStart(4, '0')}.md`, 'x');
      const { entries } = parseDocsScan(runScan(dir));
      expect(entries).toHaveLength(DOCS_MAX_FILES);
      expect(entries[0]?.path).toBe('docs/superpowers/specs/f0000.md');
      expect(entries[entries.length - 1]?.path).toBe(`docs/superpowers/specs/f${String(DOCS_MAX_FILES - 1).padStart(4, '0')}.md`);
    },
    20_000,
  );

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

  it('prints ERR:nohash and nothing else when neither sha256sum nor shasum is on PATH', () => {
    write('docs/superpowers/specs/a.md', 'x');
    const out = runScan(dir, { PATH: '/does-not-exist' });
    const { entries, err } = parseDocsScan(out);
    expect(err).toBe('nohash');
    expect(entries).toEqual([]);
  });

  it('expands a bare "~" cwd using $HOME on the machine', () => {
    write('docs/superpowers/specs/a.md', 'A');
    const out = runScan('~', { ...process.env, HOME: dir });
    const { entries } = parseDocsScan(out);
    expect(entries.map((e) => e.path)).toEqual(['docs/superpowers/specs/a.md']);
  });

  it('expands a "~/…" cwd using $HOME on the machine', () => {
    write('proj/docs/superpowers/specs/a.md', 'A');
    const out = runScan('~/proj', { ...process.env, HOME: dir });
    const { entries } = parseDocsScan(out);
    expect(entries.map((e) => e.path)).toEqual(['docs/superpowers/specs/a.md']);
  });

  it('a symlinked docs directory yields nothing (scan and read)', () => {
    const real = mkdtempSync(join(tmpdir(), 'docs-real-'));
    mkdirSync(join(real, 'superpowers/specs'), { recursive: true });
    writeFileSync(join(real, 'superpowers/specs/a.md'), 'x');
    symlinkSync(real, join(dir, 'docs'));
    try {
      const { entries } = parseDocsScan(runScan(dir));
      expect(entries).toEqual([]);
      const map = parseDocsRead(runRead(dir, ['docs/superpowers/specs/a.md']));
      expect(map.size).toBe(0);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('a symlinked plans directory excludes only plans (scan and read); specs is untouched', () => {
    write('docs/superpowers/specs/a.md', 'A');
    const secretDir = mkdtempSync(join(tmpdir(), 'docs-secret-'));
    writeFileSync(join(secretDir, 'b.md'), 'SECRET');
    symlinkSync(secretDir, join(dir, 'docs/superpowers/plans'));
    try {
      const { entries } = parseDocsScan(runScan(dir));
      expect(entries.map((e) => e.path)).toEqual(['docs/superpowers/specs/a.md']);
      const map = parseDocsRead(runRead(dir, ['docs/superpowers/specs/a.md', 'docs/superpowers/plans/b.md']));
      expect(map.get('docs/superpowers/specs/a.md')).toBe('A');
      expect(map.has('docs/superpowers/plans/b.md')).toBe(false);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
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

  it('rejects a path with an extra slash (traversal), even handed directly to the script', () => {
    writeFileSync(join(dir, 'secret.md'), 'SECRET');
    write('docs/superpowers/specs/real.md', 'x');
    const map = parseDocsRead(runRead(dir, ['docs/superpowers/specs/../../../secret.md']));
    expect(map.size).toBe(0);
  });

  it('expands a "~/…" cwd using $HOME on the machine', () => {
    write('proj/docs/superpowers/specs/a.md', 'A');
    const map = parseDocsRead(runRead('~/proj', ['docs/superpowers/specs/a.md'], { ...process.env, HOME: dir }));
    expect(map.get('docs/superpowers/specs/a.md')).toBe('A');
  });

  it('stops before crossing the cumulative budget, leaving the tail unread — and the RPC result stays under one WebSocket frame', () => {
    const paths: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = `docs/superpowers/specs/f${String(i).padStart(2, '0')}.md`;
      write(p, 'x'.repeat(DOCS_MAX_BYTES - 100)); // just under the per-file cap
      paths.push(p);
    }
    const stdout = runRead(dir, paths);
    const serialised = JSON.stringify({ type: 'rpc_result', id: 1, ok: true, result: { stdout } });
    expect(serialised.length).toBeLessThan(MAX_FRAME);

    const map = parseDocsRead(stdout);
    const returned = paths.filter((p) => map.has(p));
    const notReturned = paths.filter((p) => !map.has(p));
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.length).toBeLessThan(paths.length);
    // what came back is exactly a prefix of what was asked for; the rest is exactly the tail.
    expect(returned).toEqual(paths.slice(0, returned.length));
    expect(notReturned).toEqual(paths.slice(returned.length));
  });

  it('a single file up to DOCS_MAX_BYTES always fits the read budget on its own', () => {
    write('docs/superpowers/specs/a.md', 'x'.repeat(DOCS_MAX_BYTES));
    const map = parseDocsRead(runRead(dir, ['docs/superpowers/specs/a.md']));
    expect(map.get('docs/superpowers/specs/a.md')).toHaveLength(DOCS_MAX_BYTES);
    expect(DOCS_MAX_BYTES).toBeLessThanOrEqual(DOCS_READ_MAX_BYTES);
  });

  it('drops a body missing its terminating E line (a truncated frame)', () => {
    const stdout = 'B\t3\tdocs/superpowers/specs/a.md\n' + Buffer.from('abc').toString('base64') + '\n';
    const map = parseDocsRead(stdout);
    expect(map.size).toBe(0);
  });

  it('drops an empty body declared non-empty (a failed base64)', () => {
    const stdout = 'B\t3\tdocs/superpowers/specs/a.md\nE\n';
    const map = parseDocsRead(stdout);
    expect(map.size).toBe(0);
  });

  it('drops a body whose decoded length does not match the declared size', () => {
    const stdout = `B\t99\tdocs/superpowers/specs/a.md\n${Buffer.from('abc').toString('base64')}\nE\n`;
    const map = parseDocsRead(stdout);
    expect(map.size).toBe(0);
  });

  it('accepts a body whose decoded length matches the declared size', () => {
    const stdout = `B\t3\tdocs/superpowers/specs/a.md\n${Buffer.from('abc').toString('base64')}\nE\n`;
    const map = parseDocsRead(stdout);
    expect(map.get('docs/superpowers/specs/a.md')).toBe('abc');
  });
});

describe('parseDocsScan field validation', () => {
  it('drops an F line with a malformed sha256 (e.g. a chmod-000 file the hasher could not read)', () => {
    const { entries, err } = parseDocsScan('F\t\t0\tdocs/superpowers/specs/a.md\n');
    expect(entries).toEqual([]);
    expect(err).toBeNull();
  });

  it('drops an F line whose path does not match the doc-path shape', () => {
    const sha = createHash('sha256').update('x').digest('hex');
    const { entries } = parseDocsScan(`F\t${sha}\t1\tdocs/other/a.md\n`);
    expect(entries).toEqual([]);
  });

  it('drops an S line with a non-integer size', () => {
    const { entries } = parseDocsScan('S\tnope\tdocs/superpowers/specs/a.md\n');
    expect(entries).toEqual([]);
  });

  it('accepts a well-formed F line', () => {
    const sha = createHash('sha256').update('x').digest('hex');
    const { entries } = parseDocsScan(`F\t${sha}\t1\tdocs/superpowers/specs/a.md\n`);
    expect(entries).toEqual([{ path: 'docs/superpowers/specs/a.md', sha256: sha, size: 1 }]);
  });
});
