import { describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS, HOOK_SCRIPT, mergeClaudeSettings, mergeCodexConfig, stripClaudeSettings, stripCodexConfig } from './install.js';

const script = '/Users/p/.termhub/bin/termhub-hook';

describe('mergeClaudeSettings', () => {
  it('adds one command entry per event to an empty or missing settings file', () => {
    const out = JSON.parse(mergeClaudeSettings('', script)) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(Object.keys(out.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    expect(out.hooks.Notification[0].hooks[0].command).toBe(`${script} claude`);
  });

  it('keeps the user\'s own settings and hooks, and is idempotent', () => {
    const current = JSON.stringify({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }] },
    });
    const once = mergeClaudeSettings(current, script);
    const twice = mergeClaudeSettings(once, script);
    expect(twice).toBe(once);
    const out = JSON.parse(once) as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(out.model).toBe('opus');
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe('lint');
    expect(out.hooks.Stop.map((e) => e.hooks[0].command)).toEqual(['say done', `${script} claude`]);
  });

  it('refuses to clobber a file that is not a JSON object', () => {
    expect(() => mergeClaudeSettings('[1,2]', script)).toThrow();
    expect(() => mergeClaudeSettings('{not json', script)).toThrow();
  });
});

describe('stripClaudeSettings', () => {
  it('removes only our entries and drops keys left empty', () => {
    const merged = mergeClaudeSettings(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }), script);
    const out = JSON.parse(stripClaudeSettings(merged)) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(out.hooks)).toEqual(['Stop']);
    expect(out.hooks.Stop).toHaveLength(1);
    const bare = JSON.parse(stripClaudeSettings(mergeClaudeSettings('{"model":"opus"}', script))) as Record<string, unknown>;
    expect(bare).toEqual({ model: 'opus' });
  });
});

describe('codex config', () => {
  it('prepends notify when absent and replaces it when present', () => {
    expect(mergeCodexConfig('model = "o3"\n[profiles.x]\nfoo = 1\n', script)).toBe(`notify = ["${script}", "codex"]\nmodel = "o3"\n[profiles.x]\nfoo = 1\n`);
    expect(mergeCodexConfig('notify = ["other"]\nmodel = "o3"\n', script)).toBe(`notify = ["${script}", "codex"]\nmodel = "o3"\n`);
  });

  it('strips only our notify line', () => {
    expect(stripCodexConfig(`notify = ["${script}", "codex"]\nmodel = "o3"\n`)).toBe('model = "o3"\n');
    expect(stripCodexConfig('notify = ["other"]\n')).toBe('notify = ["other"]\n');
  });
});

describe('hook script', () => {
  it('is POSIX sh, exits quietly without tmux/env, posts in the background and never echoes the token', () => {
    expect(HOOK_SCRIPT.startsWith('#!/bin/sh')).toBe(true);
    expect(HOOK_SCRIPT).toContain('[ -n "$TMUX_PANE" ] || exit 0');
    expect(HOOK_SCRIPT).toContain('--data-binary @- >/dev/null 2>&1 &');
    expect(HOOK_SCRIPT).not.toContain('__TERMHUB_EOF__');
    expect(HOOK_SCRIPT).not.toMatch(/echo .*TOKEN/);
  });
});
