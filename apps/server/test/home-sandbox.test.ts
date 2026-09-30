import os from 'node:os';
import { describe, expect, it } from 'vitest';

// Evaluated while the file is imported, like an `os.homedir()` in a test file's module scope.
const homeAtImport = os.homedir();

describe('home sandbox (test/setup.ts)', () => {
  it('already redirects os.homedir() when a test file is imported, not only once its tests run', () => {
    expect(homeAtImport).not.toBe(os.userInfo().homedir);
    expect(homeAtImport).toBe(process.env.HOME);
  });
});
