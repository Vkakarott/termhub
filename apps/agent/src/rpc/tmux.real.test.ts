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

/** tmux exits non-zero when the server has no buffers at all; stdout is still what we want. */
function listBuffers(): string {
  try {
    return execFileSync(process.env.TMUX_PATH!, ['list-buffers'], { encoding: 'utf8' });
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? '';
  }
}

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

  it('pastes a multi-line prompt as one paste, both lines landing in the pane', async () => {
    const session = `${SESSION}-paste`;
    expect(await ensure({ session, cwd: tmpdir() })).toEqual({ created: true });

    await sendText({ session, text: 'echo linha-um\necho linha-dois', enter: true, paste: true });
    await new Promise((r) => setTimeout(r, 800));
    const { text } = await capture({ session, lines: 50 });
    expect(text).toContain('linha-um');
    expect(text).toContain('linha-dois');

    expect(await kill({ session })).toEqual({ killed: true });
  });

  it('leaves no named paste buffer behind after a failed paste', async () => {
    // A session has to be alive somewhere on this socket, or tmux itself has no server to run
    // load-buffer against ("no server running") — this keeps one up so the failure below is
    // paste-buffer not finding `${SESSION}-gone`, not the whole server being absent.
    const keepAlive = `${SESSION}-keepalive`;
    expect(await ensure({ session: keepAlive, cwd: tmpdir() })).toEqual({ created: true });

    await expect(sendText({ session: `${SESSION}-gone`, text: 'linha um\nlinha dois', enter: false, paste: true })).rejects.toMatchObject({ code: 'notfound' });
    expect(listBuffers()).not.toContain('termhub-paste-');

    expect(await kill({ session: keepAlive })).toEqual({ killed: true });
  });

  it('runs two concurrent pastes to different tabs without one crossing into the other', async () => {
    const sessionA = `${SESSION}-concA`;
    const sessionB = `${SESSION}-concB`;
    expect(await ensure({ session: sessionA, cwd: tmpdir() })).toEqual({ created: true });
    expect(await ensure({ session: sessionB, cwd: tmpdir() })).toEqual({ created: true });

    // Started together (not awaited one at a time) so their load-buffer/paste-buffer calls can
    // actually interleave — an unnamed buffer would flake here; a named one must not.
    await Promise.all([
      sendText({ session: sessionA, text: 'echo texto-a', enter: true, paste: true }),
      sendText({ session: sessionB, text: 'echo texto-b', enter: true, paste: true }),
    ]);
    await new Promise((r) => setTimeout(r, 800));

    const a = await capture({ session: sessionA, lines: 50 });
    const b = await capture({ session: sessionB, lines: 50 });
    expect(a.text).toContain('texto-a');
    expect(a.text).not.toContain('texto-b');
    expect(b.text).toContain('texto-b');
    expect(b.text).not.toContain('texto-a');

    expect(await kill({ session: sessionA })).toEqual({ killed: true });
    expect(await kill({ session: sessionB })).toEqual({ killed: true });
  });
});
