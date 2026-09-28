import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { read } from './secret.js';

const TOKEN = 'gho_S3cretTokenValue123';

beforeEach(() => {
  sh.mockReset();
});

describe('secret.read', () => {
  it('runs `gh auth token` and returns the trimmed value', async () => {
    sh.mockResolvedValue({ code: 0, stdout: `${TOKEN}\n`, stderr: '', timedOut: false });
    await expect(read({ source: 'gh_auth_token' })).resolves.toEqual({ value: TOKEN });
    expect(sh).toHaveBeenCalledWith('gh auth token');
  });

  it('fails on a non-zero exit without echoing the output', async () => {
    sh.mockResolvedValue({ code: 1, stdout: TOKEN, stderr: `not logged in ${TOKEN}`, timedOut: false });
    const err = await read({ source: 'gh_auth_token' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'failed', message: 'gh auth token failed' });
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('fails on an empty output', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '  \n', stderr: '', timedOut: false });
    await expect(read({ source: 'gh_auth_token' })).rejects.toMatchObject({ code: 'failed' });
  });

  it('fails when gh is missing', async () => {
    sh.mockResolvedValue({ code: 127, stdout: '', stderr: 'gh: not found', timedOut: false });
    await expect(read({ source: 'gh_auth_token' })).rejects.toMatchObject({ code: 'failed', message: 'gh auth token failed' });
  });

  it('fails on an oversized output without echoing it', async () => {
    const big = 'x'.repeat(4097);
    sh.mockResolvedValue({ code: 0, stdout: big, stderr: '', timedOut: false });
    const err = await read({ source: 'gh_auth_token' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'failed' });
    expect((err as Error).message).not.toContain(big);
  });

  it('raises timeout', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(read({ source: 'gh_auth_token' })).rejects.toMatchObject({ code: 'timeout' });
  });
});
