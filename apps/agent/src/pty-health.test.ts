import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSpawnHelperExecutable, findSpawnHelper } from './pty-health.js';

describe('spawn-helper health', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function fakeHelper(mode: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-helper-'));
    dirs.push(dir);
    const helper = path.join(dir, 'spawn-helper');
    fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helper, mode);
    return helper;
  }

  it('repairs a helper that lost its exec bit', () => {
    const helper = fakeHelper(0o644);
    const r = ensureSpawnHelperExecutable(helper);
    expect(r).toMatchObject({ path: helper, executable: true, repaired: true });
    expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
  });

  it('leaves an executable helper alone', () => {
    const helper = fakeHelper(0o755);
    expect(ensureSpawnHelperExecutable(helper)).toMatchObject({ executable: true, repaired: false });
  });

  it('reports instead of throwing when the file cannot be changed', () => {
    const r = ensureSpawnHelperExecutable('/nonexistent/spawn-helper');
    expect(r.executable).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('treats a platform without a helper as healthy', () => {
    expect(ensureSpawnHelperExecutable(null)).toEqual({ path: null, executable: true, repaired: false });
  });

  it('finds the helper next to the installed node-pty (or none on this platform)', () => {
    const found = findSpawnHelper();
    if (found) expect(found).toMatch(/node-pty[/\\](prebuilds|build)[/\\].*spawn-helper$/);
  });
});
