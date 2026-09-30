import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTempDir } from './temp-dir.js';

const errno = (code: string) => Object.assign(new Error(code), { code });

describe('removeTempDir', () => {
  it('removes the directory and everything in it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-temp-dir-'));
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a/b/f'), 'x');
    removeTempDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('retries with backoff, so a shell writing its history late does not break the removal', () => {
    const calls: fs.RmOptions[] = [];
    removeTempDir('/tmp/x', (_p, opts) => void calls.push(opts ?? {}));
    expect(calls).toEqual([{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }]);
  });

  it('leaves a directory that is still being written to, instead of failing the test file', () => {
    expect(() =>
      removeTempDir('/tmp/x', () => {
        throw errno('ENOTEMPTY');
      }),
    ).not.toThrow();
  });

  it('still fails on any other error', () => {
    expect(() =>
      removeTempDir('/tmp/x', () => {
        throw errno('EACCES');
      }),
    ).toThrow('EACCES');
  });
});
