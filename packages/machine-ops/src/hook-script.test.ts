/**
 * Runs the real hook script under `sh`, as Claude Code runs it: the event JSON on stdin, the tool
 * name as $1, a fake `tmux` and a fake `curl` first on PATH. The fake curl appends each request
 * body to a log, so the assertions are about what would have reached the server.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_ENV_REL, HOOK_SCRIPT } from './hooks.js';

let home: string;
let bin: string;
let log: string;
let tmp: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the script as Claude Code would: event JSON on stdin, `claude` as $1. */
function run(event: unknown): void {
  execFileSync('sh', [join(bin, 'termhub-hook'), 'claude'], {
    input: JSON.stringify(event),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMUX_PANE: '%1', TMPDIR: tmp },
    timeout: 5000,
  });
}

const logged = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

/** The script posts in the background: waits for the fake curl to have logged `n` bodies. */
async function bodies(n: number): Promise<string[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const lines = logged();
    if (lines.length >= n || Date.now() > deadline) return lines;
    await sleep(10);
  }
}

const eventOf = (body: string) => (JSON.parse(body) as { event: Record<string, unknown> }).event;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hook-home-'));
  tmp = mkdtempSync(join(tmpdir(), 'hook-tmp-'));
  bin = join(home, 'bin');
  log = join(home, 'curl.log');
  mkdirSync(join(home, '.termhub'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, HOOK_ENV_REL), `TERMHUB_HOOK_URL='http://x/api/hooks/events'\nTERMHUB_HOOK_TOKEN='thk_test'\n`);
  writeFileSync(join(bin, 'termhub-hook'), HOOK_SCRIPT);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho th-abc\n');
  // a synchronous fake: reads the body from stdin (--data-binary @-) and appends it as one line
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncat >> "${log}"; printf '\\n' >> "${log}"\n`);
  for (const f of ['termhub-hook', 'tmux', 'curl']) chmodSync(join(bin, f), 0o755);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe('termhub-hook script', () => {
  it('posts a PreToolUse event with the tool name and nothing else', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/secret', new_string: 'x' }, session_id: 's' });
    const sent = await bodies(1);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'PreToolUse', tool_name: 'Edit' } });
    expect(sent[0]).not.toContain('secret');
  });

  it('takes the event\'s own tool name, not one nested in the tool input', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { tool_name: 'Bash' } });
    const sent = await bodies(1);
    expect(eventOf(sent[0])).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Task' });
  });

  it('posts the same tool once and a different tool again', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
    const sent = await bodies(2);
    expect(sent.map((b) => eventOf(b).tool_name)).toEqual(['Edit', 'Read']);
  });

  it('resets on UserPromptSubmit and SessionStart, so the first tool of a new turn is sent', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'UserPromptSubmit', prompt: 'do it' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'SessionStart' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    const sent = await bodies(5);
    expect(sent.map((b) => eventOf(b).hook_event_name)).toEqual(['PreToolUse', 'UserPromptSubmit', 'PreToolUse', 'SessionStart', 'PreToolUse']);
  });

  it('posts nothing for a PreToolUse without a plain identifier as the tool name', async () => {
    run({ hook_event_name: 'PreToolUse' });
    run({ hook_event_name: 'PreToolUse', tool_name: 42 });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Ev"il' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Ev\\il' });
    await sleep(300);
    expect(existsSync(log)).toBe(false);
  });

  it('still posts the other events whole', async () => {
    run({ hook_event_name: 'Stop', last_assistant_message: 'Pronto?' });
    const sent = await bodies(1);
    expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'Stop', last_assistant_message: 'Pronto?' } });
  });

  it('keeps the marker inside TMPDIR whatever the session name contains', async () => {
    writeFileSync(join(bin, 'tmux'), "#!/bin/sh\necho '../evil name'\n");
    chmodSync(join(bin, 'tmux'), 0o755);
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    await bodies(1);
    expect(existsSync(join(tmp, '..', 'evil name'))).toBe(false);
    expect(existsSync(join(home, 'evil name'))).toBe(false);
  });
});
