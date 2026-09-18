import { PASTE_MAX_BYTES, buildPasteScript } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { pasteFile } from './paste.js';

beforeEach(() => {
  sh.mockReset();
});

describe('file.paste', () => {
  it('decodes the base64 payload and forwards the raw bytes as input, with a 60s timeout', async () => {
    const data = Buffer.from('hello world');
    sh.mockResolvedValue({ code: 0, stdout: '/home/u/.cache/termhub/paste/paste-x.txt\n', stderr: '', timedOut: false });
    await expect(pasteFile({ name: 'paste-x.txt', data_b64: data.toString('base64') })).resolves.toEqual({
      path: '/home/u/.cache/termhub/paste/paste-x.txt',
    });
    expect(sh).toHaveBeenCalledWith(buildPasteScript('paste-x.txt'), { input: data, timeoutMs: 60_000 });
  });

  it('rejects a payload larger than PASTE_MAX_BYTES without calling sh', async () => {
    const big = Buffer.alloc(PASTE_MAX_BYTES + 1);
    await expect(pasteFile({ name: 'big.bin', data_b64: big.toString('base64') })).rejects.toMatchObject({ code: 'invalid' });
    expect(sh).not.toHaveBeenCalled();
  });

  it('takes the last non-empty stdout line as the path', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '\n/home/u/.cache/termhub/paste/paste-x.txt\n\n', stderr: '', timedOut: false });
    await expect(pasteFile({ name: 'x', data_b64: Buffer.from('a').toString('base64') })).resolves.toEqual({
      path: '/home/u/.cache/termhub/paste/paste-x.txt',
    });
  });

  it('raises internal when the last stdout line is not an absolute path', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'oops\n', stderr: '', timedOut: false });
    await expect(pasteFile({ name: 'x', data_b64: Buffer.from('a').toString('base64') })).rejects.toMatchObject({ code: 'internal' });
  });

  it('raises internal on a non-zero exit', async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: 'disk full', timedOut: false });
    await expect(pasteFile({ name: 'x', data_b64: Buffer.from('a').toString('base64') })).rejects.toMatchObject({ code: 'internal' });
  });

  it('raises timeout', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(pasteFile({ name: 'x', data_b64: Buffer.from('a').toString('base64') })).rejects.toMatchObject({ code: 'timeout' });
  });
});
