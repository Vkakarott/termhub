import { buildDocsReadScript, buildDocsScanScript, shellQuote } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { read, scan } from './docs.js';

beforeEach(() => {
  sh.mockReset();
});

describe('docs.scan', () => {
  it('runs buildDocsScanScript(shellQuote(cwd)) and passes stdout through unchanged', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'F\tabc\t3\tdocs/superpowers/specs/a.md\n', stderr: '', timedOut: false });
    await expect(scan({ cwd: '/home/u/proj' })).resolves.toEqual({ stdout: 'F\tabc\t3\tdocs/superpowers/specs/a.md\n' });
    expect(sh).toHaveBeenCalledWith(buildDocsScanScript(shellQuote('/home/u/proj')));
  });

  it('passes an ERR:notfound stdout through unchanged instead of throwing', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'ERR:notfound\n', stderr: '', timedOut: false });
    await expect(scan({ cwd: '/nope' })).resolves.toEqual({ stdout: 'ERR:notfound\n' });
  });

  it('raises internal on a process-level failure', async () => {
    sh.mockResolvedValue({ code: 2, stdout: '', stderr: 'sh: syntax error', timedOut: false });
    await expect(scan({ cwd: '/home/u/proj' })).rejects.toMatchObject({ code: 'internal' });
  });

  it('raises timeout when sh() times out', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(scan({ cwd: '/home/u/proj' })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('docs.read', () => {
  it('runs buildDocsReadScript(shellQuote(cwd), paths.map(shellQuote)) and passes stdout through', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'B\tdocs/superpowers/specs/a.md\nQQ==\nE\n', stderr: '', timedOut: false });
    await expect(read({ cwd: '/home/u/proj', paths: ['docs/superpowers/specs/a.md'] })).resolves.toEqual({
      stdout: 'B\tdocs/superpowers/specs/a.md\nQQ==\nE\n',
    });
    expect(sh).toHaveBeenCalledWith(buildDocsReadScript(shellQuote('/home/u/proj'), ['docs/superpowers/specs/a.md'].map(shellQuote)));
  });

  it('quotes every path, not just the cwd', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await read({ cwd: '/home/u/proj', paths: ['docs/superpowers/specs/a.md', 'docs/superpowers/plans/b.md'] });
    const script = (sh.mock.calls[0] as string[])[0]!;
    expect(script).toContain(shellQuote('docs/superpowers/specs/a.md'));
    expect(script).toContain(shellQuote('docs/superpowers/plans/b.md'));
  });

  it('raises internal on a process-level failure', async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
    await expect(read({ cwd: '/home/u/proj', paths: ['docs/superpowers/specs/a.md'] })).rejects.toMatchObject({ code: 'internal' });
  });

  it('raises timeout when sh() times out', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(read({ cwd: '/home/u/proj', paths: ['docs/superpowers/specs/a.md'] })).rejects.toMatchObject({ code: 'timeout' });
  });
});
