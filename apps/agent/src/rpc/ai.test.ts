import { DEFAULT_CONFIG_DIRS, configDirPrefix, credentialScript } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { credential } from './ai.js';

beforeEach(() => {
  sh.mockReset();
});

describe('ai.credential', () => {
  it('builds the $D prefix from DEFAULT_CONFIG_DIRS when config_dir is null', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'TOKEN\n', stderr: '', timedOut: false });
    await expect(credential({ provider: 'claude', config_dir: null })).resolves.toEqual({ stdout: 'TOKEN\n' });
    const expectedScript = `${configDirPrefix(null, DEFAULT_CONFIG_DIRS.claude)}; ${credentialScript('claude')}`;
    expect(sh).toHaveBeenCalledWith(expectedScript);
  });

  it('builds the $D prefix from a custom config_dir', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '{}\n', stderr: '', timedOut: false });
    await credential({ provider: 'claude', config_dir: '~/.claude-work' });
    const expectedScript = `${configDirPrefix('~/.claude-work', DEFAULT_CONFIG_DIRS.claude)}; ${credentialScript('claude')}`;
    expect(sh).toHaveBeenCalledWith(expectedScript);
  });

  it('never leaks the credential in an error path (raises internal on a non-zero exit)', async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: '', timedOut: false });
    await expect(credential({ provider: 'claude', config_dir: null })).rejects.toMatchObject({ code: 'internal' });
  });

  it('raises timeout', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(credential({ provider: 'claude', config_dir: null })).rejects.toMatchObject({ code: 'timeout' });
  });
});
