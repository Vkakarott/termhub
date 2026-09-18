import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMainModule, resolveScriptPath } from './paths.js';

describe('resolveScriptPath / isMainModule (npm-global-bin symlink)', () => {
  let dir: string;
  let realTarget: string;
  let symlink: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-paths-'));
    realTarget = path.join(dir, 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(realTarget), { recursive: true });
    fs.writeFileSync(realTarget, '// fake entry point\n', 'utf8');
    // Mirrors `npm i -g`: the global bin dir gets a symlink pointing at dist/cli.js.
    symlink = path.join(dir, 'bin-symlink.js');
    fs.symlinkSync(realTarget, symlink);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolveScriptPath() follows the symlink to the real file', () => {
    expect(resolveScriptPath(symlink)).toBe(fs.realpathSync(realTarget));
    expect(resolveScriptPath(symlink)).not.toBe(symlink);
  });

  it('resolveScriptPath() falls back to path.resolve() when realpathSync throws (missing file)', () => {
    const missing = path.join(dir, 'nope.js');
    expect(resolveScriptPath(missing)).toBe(path.resolve(missing));
  });

  it('resolveScriptPath() returns "" for an undefined argv1', () => {
    expect(resolveScriptPath(undefined)).toBe('');
  });

  it('isMainModule() matches when import.meta.url is the *real* target and argv[1] is the symlink (the npm global bin case)', () => {
    const importMetaUrl = pathToFileURL(realTarget).href;
    expect(isMainModule(importMetaUrl, symlink)).toBe(true);
  });

  it('isMainModule() matches when both are the direct (non-symlinked) path — the plain `node dist/cli.js` / tsx case', () => {
    const importMetaUrl = pathToFileURL(realTarget).href;
    expect(isMainModule(importMetaUrl, realTarget)).toBe(true);
  });

  it('isMainModule() is false for an unrelated import.meta.url (this module was merely imported, not run)', () => {
    const otherUrl = pathToFileURL(path.join(dir, 'not-the-entry-point.js')).href;
    expect(isMainModule(otherUrl, symlink)).toBe(false);
  });

  it('isMainModule() is false when argv[1] is undefined', () => {
    expect(isMainModule(pathToFileURL(realTarget).href, undefined)).toBe(false);
  });
});
