import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOOK_SCRIPT } from '@termhub/machine-ops';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heal, install, uninstall } from './hooks.js';

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
    await expect(install(params, home)).resolves.toEqual({ home, claude: 'installed', codex: 'skipped', claude_dirs: ['~/.claude'] });
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

  it('also hooks the Claude config dirs of the machine\'s accounts that exist, and says which', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await writeFile(path.join(home, '.claude_pedro/settings.json'), JSON.stringify({ model: 'sonnet' }));
    const r = await install({ ...params, claude_dirs: ['~/.claude_pedro', '~/.claude-missing'] }, home);
    expect(r.claude_dirs).toEqual(['~/.claude', '~/.claude_pedro']);
    const settings = JSON.parse(await read('.claude_pedro/settings.json')) as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.model).toBe('sonnet');
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`${path.join(home, '.termhub/bin/termhub-hook')} claude`);
    await expect(stat(path.join(home, '.claude-missing'))).rejects.toMatchObject({ code: 'ENOENT' });

    await uninstall({ claude_dirs: ['~/.claude_pedro'] }, home);
    expect(JSON.parse(await read('.claude_pedro/settings.json'))).toEqual({ model: 'sonnet' });
  });

  it('finds the config dirs of the machine itself when none are registered, and gives them back on uninstall', async () => {
    await mkdir(path.join(home, '.claude-work'), { recursive: true });
    await writeFile(path.join(home, '.claude-work/settings.json'), '{}');
    await writeFile(path.join(home, '.zshrc'), "alias cw='CLAUDE_CONFIG_DIR=~/.claude-work claude'\n");

    const r = await install(params, home);

    expect(r.claude_dirs).toEqual(['~/.claude', '~/.claude-work']);
    const settings = JSON.parse(await read('.claude-work/settings.json')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`${path.join(home, '.termhub/bin/termhub-hook')} claude`);

    await uninstall({}, home);
    expect(JSON.parse(await read('.claude-work/settings.json'))).toEqual({});
  });

  it('checks every settings file before writing any', async () => {
    await mkdir(path.join(home, '.claude_pedro'), { recursive: true });
    await writeFile(path.join(home, '.claude_pedro/settings.json'), '[1]');
    await expect(install({ ...params, claude_dirs: ['~/.claude_pedro'] }, home)).rejects.toMatchObject({ code: 'failed', path: '.claude_pedro/settings.json' });
    await expect(stat(path.join(home, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
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

describe('heal', () => {
  it('does nothing on a machine where termhub never installed its hooks', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude/settings.json'), '{}');

    await expect(heal(home)).resolves.toEqual([]);

    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({});
  });

  it('hooks a config dir that showed up after the install and leaves the settled ones alone', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.claude-new'), { recursive: true });
    await writeFile(path.join(home, '.claude-new/settings.json'), JSON.stringify({ model: 'opus' }));
    const before = await read('.claude/settings.json');

    await expect(heal(home)).resolves.toEqual(['~/.claude-new']);

    const settings = JSON.parse(await read('.claude-new/settings.json')) as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Notification[0].hooks[0].command).toBe(`${path.join(home, '.termhub/bin/termhub-hook')} claude`);
    expect(await read('.claude/settings.json')).toBe(before);
  });

  it('leaves a settings file it cannot parse where it is', async () => {
    await install(params, home);
    await mkdir(path.join(home, '.claude-broken'), { recursive: true });
    await writeFile(path.join(home, '.claude-broken/settings.json'), '{not json');

    await expect(heal(home)).resolves.toEqual([]);

    expect(await read('.claude-broken/settings.json')).toBe('{not json');
  });
});
