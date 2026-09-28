import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remove, write } from './tab-mcp.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'termhub-tabmcp-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('tab.mcp.write / tab.mcp.remove', () => {
  it('writes the body (from stdin) to a 0600 file in a 0700 dir, then removes it', async () => {
    await expect(write({ tab_id: 'abc123', file: 'mcp.json', body: '{"x":1}' }, home)).resolves.toEqual({ ok: true });
    const dir = path.join(home, '.termhub/tabs/abc123');
    const file = path.join(dir, 'mcp.json');
    expect(await readFile(file, 'utf8')).toBe('{"x":1}');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await expect(remove({ tab_id: 'abc123' }, home)).resolves.toEqual({ ok: true });
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes the token file the same way', async () => {
    await expect(write({ tab_id: 'abc123', file: 'token', body: 'thb_pat_x' }, home)).resolves.toEqual({ ok: true });
    expect(await readFile(path.join(home, '.termhub/tabs/abc123/token'), 'utf8')).toBe('thb_pat_x');
  });

  it('never logs the body', async () => {
    const spy = vi.spyOn(console, 'error');
    await write({ tab_id: 'abc123', file: 'token', body: 'thb_pat_super_secret' }, home);
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('thb_pat_super_secret');
    spy.mockRestore();
  });

  it('raises internal when the target cannot be created', async () => {
    // a plain file where a directory needs to go: mkdir -p fails
    await writeFile(path.join(home, '.termhub'), 'not a dir');
    await expect(write({ tab_id: 'abc123', file: 'token', body: 'x' }, home)).rejects.toMatchObject({ code: 'internal' });
  });

  it('remove is a no-op (still ok) when the dir never existed', async () => {
    await expect(remove({ tab_id: 'neverexisted' }, home)).resolves.toEqual({ ok: true });
  });
});
