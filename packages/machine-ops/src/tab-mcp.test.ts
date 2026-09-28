import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTabMcpRemoveScript, buildTabMcpWriteScript } from './tab-mcp.js';

describe('tab MCP scripts', () => {
  it('writes the body from stdin to a 0600 file in a 0700 dir, then removes the dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'tabmcp-'));
    const env = { ...process.env, HOME: home };
    const out = execFileSync('sh', ['-c', buildTabMcpWriteScript('abc123', 'mcp.json')], { input: '{"x":1}', env }).toString();
    expect(out.trim()).toBe('ok');
    const dir = join(home, '.termhub/tabs/abc123');
    expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).toBe('{"x":1}');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
    execFileSync('sh', ['-c', buildTabMcpRemoveScript('abc123')], { env });
    expect(existsSync(dir)).toBe(false);
  });
  it('refuses a tab id that is not [a-z0-9]', () => {
    expect(() => buildTabMcpWriteScript('../x', 'token')).toThrow('tab id inválido');
    expect(() => buildTabMcpRemoveScript("a'b")).toThrow('tab id inválido');
  });
  it('never puts the body in the script', () => {
    expect(buildTabMcpWriteScript('abc', 'token')).not.toContain('thb_pat_');
  });
});
