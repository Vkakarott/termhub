import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedPaths, snapshotHome } from './real-home-guard.js';

const dirs: string[] = [];
function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'th-guard-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const WATCHED = ['.termhub/hook.env', '.codex/hooks.json'];

describe('real-home guard', () => {
  it('reports nothing when the watched paths are unchanged', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.termhub'));
    fs.writeFileSync(path.join(home, '.termhub/hook.env'), 'a');
    const before = snapshotHome(home, WATCHED);
    expect(changedPaths(before, snapshotHome(home, WATCHED))).toEqual([]);
  });

  it('reports a modified, a created and a removed path', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.termhub'));
    fs.writeFileSync(path.join(home, '.termhub/hook.env'), 'a');
    const before = snapshotHome(home, WATCHED);
    fs.writeFileSync(path.join(home, '.termhub/hook.env'), 'longer content');
    expect(changedPaths(before, snapshotHome(home, WATCHED))).toEqual(['.termhub/hook.env']);

    const before2 = snapshotHome(home, WATCHED);
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex/hooks.json'), '{}');
    expect(changedPaths(before2, snapshotHome(home, WATCHED))).toEqual(['.codex/hooks.json']);

    const before3 = snapshotHome(home, WATCHED);
    fs.rmSync(path.join(home, '.termhub/hook.env'));
    expect(changedPaths(before3, snapshotHome(home, WATCHED))).toEqual(['.termhub/hook.env']);
  });
});
