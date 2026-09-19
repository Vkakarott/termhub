import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import { installHooks, uninstallHooks } from './install.js';

/** The shell path for real: a `local` machine runs the same `sh` script, against a throwaway $HOME. */
const machine = { id: 'm1', type: 'local' } as Machine;
const url = 'https://app.termhub.dev/api/hooks';

let home: string;
let realHome: string | undefined;
const read = (rel: string) => readFile(path.join(home, rel), 'utf8');
type Settings = { model?: string; hooks?: Record<string, { hooks: { command: string }[] }[]> };

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'termhub-install-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(async () => {
  process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

describe('installHooks on a local/ssh machine', () => {
  it('hooks ~/.claude and the account dirs that exist, keeping what is there', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await writeFile(path.join(home, '.claude_pedro/settings.json'), JSON.stringify({ model: 'sonnet' }, null, 2) + '\n');
    const r = await installHooks(machine, 'thb_hk_abc', url, ['~/.claude_pedro', '~/.claude-missing']);
    expect(r).toMatchObject({ home, claude: 'installed', codex: 'skipped', claude_dirs: ['~/.claude', '~/.claude_pedro'] });

    const script = `${home}/.termhub/bin/termhub-hook claude`;
    const main = JSON.parse(await read('.claude/settings.json')) as Settings;
    const extra = JSON.parse(await read('.claude_pedro/settings.json')) as Settings;
    expect(main.hooks?.Stop[0].hooks[0].command).toBe(script);
    expect(extra.model).toBe('sonnet');
    expect(extra.hooks?.Stop[0].hooks[0].command).toBe(script);
    await expect(stat(path.join(home, '.claude-missing'))).rejects.toMatchObject({ code: 'ENOENT' });

    await uninstallHooks(machine, ['~/.claude_pedro']);
    expect(JSON.parse(await read('.claude_pedro/settings.json'))).toEqual({ model: 'sonnet' });
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({});
  });

  it('refuses a broken settings.json in an account dir before writing anything', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await writeFile(path.join(home, '.claude_pedro/settings.json'), '{not json');
    await expect(installHooks(machine, 'thb_hk_abc', url, ['~/.claude_pedro'])).rejects.toThrow('~/.claude_pedro/settings.json não é JSON válido');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
