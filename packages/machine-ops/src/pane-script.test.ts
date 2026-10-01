/**
 * Runs the real pane script with `/bin/sh` against a real tmux, on a PRIVATE server
 * (`tmux -L th-test-pane-<pid> -f /dev/null`): the default socket may hold live termhub tabs,
 * so nothing here ever talks to it. Skipped when tmux is not installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPaneForegroundScript, parsePaneForeground } from './pane-script.js';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const SOCKET = `th-test-pane-${process.pid}`;
const TMUX = `tmux -L ${SOCKET} -f /dev/null`;
const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined } as NodeJS.ProcessEnv;

const tmux = (...args: string[]) => execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', env, timeout: 10_000 });
const pane = (session: string) => spawnSync('/bin/sh', ['-c', buildPaneForegroundScript(session, TMUX)], { encoding: 'utf8', env, timeout: 10_000 });

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterAll(() => {
  if (hasTmux) spawnSync('tmux', ['-L', SOCKET, 'kill-server'], { env });
});

describe('buildPaneForegroundScript', () => {
  it('refuses a session name that is not one of ours', () => {
    expect(() => buildPaneForegroundScript("a'; rm -rf ~")).toThrow('invalid tmux session name');
    expect(() => buildPaneForegroundScript('a'.repeat(129))).toThrow('invalid tmux session name');
  });

  it('quotes the target', () => {
    expect(buildPaneForegroundScript('th-p-t1')).toContain("-t '=th-p-t1:'");
  });

  it('reads only its three words', () => {
    expect(parsePaneForeground('shell\n')).toBe('shell');
    expect(parsePaneForeground('busy')).toBe('busy');
    expect(parsePaneForeground('dead\n')).toBe('dead');
    expect(parsePaneForeground('')).toBeNull();
    expect(parsePaneForeground('sh: ps: not found')).toBeNull();
  });
});

describe.skipIf(!hasTmux)('buildPaneForegroundScript against a real tmux', () => {
  it('busy while a program runs on top of the shell, shell once it exits (the agent died without a Stop)', async () => {
    tmux('new-session', '-d', '-s', 'th-pane-a', '-x', '80', '-y', '24', 'sh');
    tmux('send-keys', '-t', '=th-pane-a:', 'sleep 30', 'Enter');
    await until(() => pane('th-pane-a').stdout.trim() === 'busy', 'sleep in front');
    tmux('send-keys', '-t', '=th-pane-a:', 'C-c');
    await until(() => pane('th-pane-a').stdout.trim() === 'shell', 'the shell back in front');
    expect(pane('th-pane-a').status).toBe(0);
  });

  it('dead when the pane process exited and tmux kept the pane', async () => {
    tmux('new-session', '-d', '-s', 'th-pane-b', 'sh');
    tmux('set-option', '-t', '=th-pane-b:', 'remain-on-exit', 'on');
    tmux('send-keys', '-t', '=th-pane-b:', 'exit', 'Enter');
    await until(() => pane('th-pane-b').stdout.trim() === 'dead', 'the pane to die');
  });

  it('fails on a session that does not exist', () => {
    const r = pane('th-pane-missing');
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
