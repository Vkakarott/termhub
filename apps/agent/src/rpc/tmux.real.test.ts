import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture, ensure, kill, sendKey, sendText } from './tmux.js';

const SOCKET = `termhub-test-${process.pid}`;
const SESSION = `termhub-real-${process.pid}`;

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTmux)('tmux RPCs against a real tmux', () => {
  // TMUX_PATH is what exec.ts reads; the wrapper pins every call to our own socket. Created here
  // (not at module top level) so it is only ever made — and cleaned up — when the suite actually runs.
  let wrapper: string;

  beforeAll(() => {
    wrapper = mkdtempSync(join(tmpdir(), 'tmux-wrap-'));
    const path = join(wrapper, 'tmux');
    execFileSync('sh', ['-c', `printf '#!/bin/sh\\nexec tmux -L %s "$@"\\n' ${SOCKET} > ${path} && chmod +x ${path}`]);
    process.env.TMUX_PATH = path;
  });

  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* no server to kill */
    }
    rmSync(wrapper, { recursive: true, force: true });
    delete process.env.TMUX_PATH;
  });

  it('creates the session once, types into it and reads it back', async () => {
    expect(await ensure({ session: SESSION, cwd: tmpdir() })).toEqual({ created: true });
    expect(await ensure({ session: SESSION, cwd: tmpdir() })).toEqual({ created: false });

    await sendText({ session: SESSION, text: 'echo termhub-ok', enter: true });
    await new Promise((r) => setTimeout(r, 800));
    const { text } = await capture({ session: SESSION, lines: 50 });
    expect(text).toContain('termhub-ok');

    await sendKey({ session: SESSION, key: 'C-c' });
    expect(await kill({ session: SESSION })).toEqual({ killed: true });
  });

  it('refuses to type into a session that is not there', async () => {
    await expect(sendText({ session: `${SESSION}-gone`, text: 'x', enter: false })).rejects.toMatchObject({ code: 'notfound' });
  });
});
