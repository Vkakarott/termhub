import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverClaudeDirs } from './claude-dirs.js';

let home: string;
let outside: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'termhub-dirs-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'termhub-outside-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const claudeDir = async (name: string, marker = 'settings.json') => {
  await mkdir(path.join(home, name), { recursive: true });
  await writeFile(path.join(home, name, marker), '{}');
};

describe('discoverClaudeDirs', () => {
  it('finds the home dirs that hold Claude Code and the dirs the shell rc points at', async () => {
    await claudeDir('.claude');
    await claudeDir('.claude-work');
    await mkdir(path.join(home, '.claude-notes'), { recursive: true });
    await writeFile(path.join(home, '.zshrc'), `alias cw='CLAUDE_CONFIG_DIR=${outside} claude'\n`);

    const dirs = await discoverClaudeDirs(home);

    expect(dirs).toContain('~/.claude');
    expect(dirs).toContain('~/.claude-work');
    expect(dirs).toContain(outside);
    expect(dirs).not.toContain('~/.claude-notes');
  });

  it('drops a rc path that is not a directory on this machine', async () => {
    await writeFile(path.join(home, '.bashrc'), 'export CLAUDE_CONFIG_DIR=~/.claude-gone\n');
    await expect(discoverClaudeDirs(home)).resolves.toEqual([]);
  });

  it('answers an empty list on a home with nothing of ours', async () => {
    await expect(discoverClaudeDirs(home)).resolves.toEqual([]);
  });
});
