import { buildFsListScript, buildMkdirScript, shellQuote } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { list, mkdir } from './fs.js';

beforeEach(() => {
  sh.mockReset();
});

describe('fs.list', () => {
  it('runs buildFsListScript(shellQuote(path)) and passes stdout through unchanged', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'HOME:/home/u\nPWD:/tmp\nDIR:a\n', stderr: '', timedOut: false });
    await expect(list({ path: '/tmp' })).resolves.toEqual({ stdout: 'HOME:/home/u\nPWD:/tmp\nDIR:a\n' });
    expect(sh).toHaveBeenCalledWith(buildFsListScript(shellQuote('/tmp')));
  });

  it('passes an ERR:eperm stdout through unchanged instead of throwing — the server maps ERR: tags', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'ERR:eperm\n', stderr: '', timedOut: false });
    await expect(list({ path: '/root' })).resolves.toEqual({ stdout: 'ERR:eperm\n' });
  });

  it('raises internal on a process-level failure (non-zero exit the script never produces itself)', async () => {
    sh.mockResolvedValue({ code: 2, stdout: '', stderr: 'sh: syntax error', timedOut: false });
    await expect(list({ path: '/tmp' })).rejects.toMatchObject({ code: 'internal' });
  });

  it('raises timeout when sh() times out', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(list({ path: '/tmp' })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('fs.mkdir', () => {
  it('runs buildMkdirScript(shellQuote(parent), shellQuote(name)) and passes stdout through', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'PWD:/tmp/new\n', stderr: '', timedOut: false });
    await expect(mkdir({ parent: '/tmp', name: 'new' })).resolves.toEqual({ stdout: 'PWD:/tmp/new\n' });
    expect(sh).toHaveBeenCalledWith(buildMkdirScript(shellQuote('/tmp'), shellQuote('new')));
  });

  it('passes an ERR:exists stdout through unchanged', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'ERR:exists\n', stderr: '', timedOut: false });
    await expect(mkdir({ parent: '/tmp', name: 'new' })).resolves.toEqual({ stdout: 'ERR:exists\n' });
  });

  it('raises timeout when sh() times out', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(mkdir({ parent: '/tmp', name: 'new' })).rejects.toMatchObject({ code: 'timeout' });
  });
});
