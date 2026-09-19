import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOOK_SCRIPT } from '@termhub/machine-ops';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { install, uninstall } from './hooks.js';

let home: string;
const params = { hooks_url: 'https://app.termhub.dev/api/hooks', token: 'thb_hk_abc-123' };
const read = (rel: string) => readFile(path.join(home, rel), 'utf8');
const mode = async (rel: string) => (await stat(path.join(home, rel))).mode & 0o777;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'termhub-hooks-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('hooks.install', () => {
  it('writes the script (755), the env (600) and the Claude entries on a bare home; skips Codex when absent', async () => {
    await expect(install(params, home)).resolves.toEqual({ home, claude: 'installed', codex: 'skipped' });
    expect(await read('.termhub/bin/termhub-hook')).toBe(HOOK_SCRIPT);
    expect(await mode('.termhub/bin/termhub-hook')).toBe(0o755);
    expect(await read('.termhub/hook.env')).toBe("TERMHUB_HOOK_URL='https://app.termhub.dev/api/hooks'\nTERMHUB_HOOK_TOKEN='thb_hk_abc-123'\n");
    expect(await mode('.termhub/hook.env')).toBe(0o600);
    const settings = JSON.parse(await read('.claude/settings.json')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`${path.join(home, '.termhub/bin/termhub-hook')} claude`);
    await expect(stat(path.join(home, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the user\'s settings, writes Codex when ~/.codex exists, and is idempotent', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/config.toml'), 'model = "o3"\n');
    await expect(install(params, home)).resolves.toMatchObject({ claude: 'installed', codex: 'installed' });
    const once = await read('.claude/settings.json');
    await install(params, home);
    expect(await read('.claude/settings.json')).toBe(once);
    const settings = JSON.parse(once) as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop.map((e) => e.hooks[0].command)).toEqual(['say done', `${path.join(home, '.termhub/bin/termhub-hook')} claude`]);
    expect(await read('.codex/config.toml')).toBe(`notify = [${JSON.stringify(path.join(home, '.termhub/bin/termhub-hook'))}, "codex"]\nmodel = "o3"\n`);
  });

  it('refuses to clobber a settings.json that is not a JSON object and writes nothing', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), '{not json');
    await expect(install(params, home)).rejects.toMatchObject({ code: 'failed', path: '.claude/settings.json' });
    expect(await read('.claude/settings.json')).toBe('{not json');
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('hooks.uninstall', () => {
  it('removes the files and only our entries; a missing install is not an error', async () => {
    await expect(uninstall({}, home)).resolves.toEqual({ removed: true });
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex/config.toml'), 'model = "o3"\n');
    await install(params, home);
    await expect(uninstall({}, home)).resolves.toEqual({ removed: true });
    await expect(stat(path.join(home, '.termhub/bin/termhub-hook'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(home, '.termhub/hook.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    expect(await read('.codex/config.toml')).toBe('model = "o3"\n');
  });

  it('leaves an unparseable settings.json alone', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), '{not json');
    await expect(uninstall({}, home)).resolves.toEqual({ removed: true });
    expect(await read('.claude/settings.json')).toBe('{not json');
  });
});
