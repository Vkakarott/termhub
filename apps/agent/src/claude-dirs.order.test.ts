import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The order `readdir` answers in belongs to the filesystem (ext4 with dir_index hashes the names).
// This file scrambles it on purpose, so the test says the same thing on every machine.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  type Entry = string | { name: string };
  const nameOf = (e: Entry) => (typeof e === 'string' ? e : e.name);
  const readdir = async (dir: string, options?: unknown) => {
    const list = (await (actual.readdir as unknown as (d: string, o?: unknown) => Promise<Entry[]>)(dir, options)) as Entry[];
    return [...list].sort((a, b) => (nameOf(a) < nameOf(b) ? 1 : -1)); // the reverse of name order
  };
  return { ...actual, readdir, default: { ...actual, readdir } };
});

import { discoverClaudeDirs } from './claude-dirs.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'termhub-dirs-order-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('discoverClaudeDirs order', () => {
  it('lists the home dirs in name order, whatever order the filesystem answers in', async () => {
    for (const name of ['.claude-z', '.claude', '.claude-b', '.claude-000']) {
      await mkdir(path.join(home, name), { recursive: true });
      await writeFile(path.join(home, name, 'settings.json'), '{}');
    }

    await expect(discoverClaudeDirs(home)).resolves.toEqual(['~/.claude', '~/.claude-000', '~/.claude-b', '~/.claude-z']);
  });
});
