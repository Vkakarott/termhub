import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run, sh } = vi.hoisted(() => ({ run: vi.fn(), sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, run, sh };
});
// Deterministic buffer name so the paste tests can assert the exact argv instead of a pattern.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => 'fixed-uuid' };
});

import { buildPaneForegroundScript, buildScrollScript, shellQuote } from '@termhub/machine-ops';
import { capture, ensure, foreground, kill, list, scroll, sendKey, sendText } from './tmux.js';

beforeEach(() => {
  run.mockReset();
  sh.mockReset();
});

afterEach(() => {
  delete process.env.TMUX_PATH;
});

describe('tmux rpc handlers', () => {
  it('tmux.list lists sessions with the exact argv, splitting and trimming names', async () => {
    run.mockResolvedValue({ code: 0, stdout: 'th-a\nth-b\n', stderr: '', timedOut: false });
    await expect(list({})).resolves.toEqual({ sessions: ['th-a', 'th-b'] });
    expect(run).toHaveBeenCalledWith('tmux', ['list-sessions', '-F', '#{session_name}']);
  });

  it('tmux.list returns an empty array on a non-zero exit (no server running)', async () => {
    run.mockResolvedValue({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-...', timedOut: false });
    await expect(list({})).resolves.toEqual({ sessions: [] });
  });

  it('tmux.list raises no_tmux when the binary could not be spawned (ENOENT)', async () => {
    run.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: false, error: 'enoent' });
    await expect(list({})).rejects.toMatchObject({ code: 'no_tmux' });
  });

  it('tmux.list raises internal (not no_tmux) on a maxBuffer overflow', async () => {
    run.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: false, error: 'maxbuffer' });
    await expect(list({})).rejects.toMatchObject({ code: 'internal' });
  });

  it('tmux.list raises timeout when the process is killed on the deadline', async () => {
    run.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(list({})).rejects.toMatchObject({ code: 'timeout' });
  });

  it('tmux.list prefers timeout over a stray error marker (defensive ordering)', async () => {
    run.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true, error: 'enoent' });
    await expect(list({})).rejects.toMatchObject({ code: 'timeout' });
  });

  it('tmux.kill builds the =session target and reports killed from the exit code', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(kill({ session: 'th-a' })).resolves.toEqual({ killed: true });
    expect(run).toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=th-a']);
  });

  it('tmux.kill reports killed:false on a non-zero exit (no such session)', async () => {
    run.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find session", timedOut: false });
    await expect(kill({ session: 'th-a' })).resolves.toEqual({ killed: false });
  });

  it('tmux.capture uses -S -<lines> and =session, returning stdout as text', async () => {
    run.mockResolvedValue({ code: 0, stdout: 'hello\n', stderr: '', timedOut: false });
    await expect(capture({ session: 'th-a', lines: 200 })).resolves.toEqual({ text: 'hello\n' });
    expect(run).toHaveBeenCalledWith('tmux', ['capture-pane', '-p', '-S', '-200', '-t', '=th-a:']);
  });

  it('tmux.capture with escapes adds -e and says the text carries them', async () => {
    run.mockResolvedValue({ code: 0, stdout: '❯ \x1b[2mcommit it\x1b[0m\n', stderr: '', timedOut: false });
    await expect(capture({ session: 'th-a', lines: 15, escapes: true })).resolves.toEqual({ text: '❯ \x1b[2mcommit it\x1b[0m\n', escapes: true });
    expect(run).toHaveBeenCalledWith('tmux', ['capture-pane', '-p', '-e', '-S', '-15', '-t', '=th-a:']);
  });

  it('tmux.capture raises notfound on a non-zero exit', async () => {
    run.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find session th-a", timedOut: false });
    await expect(capture({ session: 'th-a', lines: 200 })).rejects.toMatchObject({ code: 'notfound' });
  });

  it('tmux.capture raises internal (not notfound) on a maxBuffer overflow', async () => {
    run.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: false, error: 'maxbuffer' });
    await expect(capture({ session: 'th-a', lines: 5000 })).rejects.toMatchObject({ code: 'internal' });
  });

  it('respects a TMUX_PATH override for every method', async () => {
    process.env.TMUX_PATH = '/custom/tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await kill({ session: 'th-a' });
    expect(run).toHaveBeenCalledWith('/custom/tmux', ['kill-session', '-t', '=th-a']);
  });
});

describe('ensure', () => {
  it('does nothing when the session is already there', async () => {
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(ensure({ session: 's1', cwd: '/home/u/app' })).resolves.toEqual({ created: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('tmux', ['has-session', '-t', '=s1']);
  });

  it('creates a detached session in cwd when it is missing', async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "can't find session", timedOut: false });
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(ensure({ session: 's1', cwd: '/home/u/app' })).resolves.toEqual({ created: true });
    expect(run).toHaveBeenLastCalledWith('tmux', ['new-session', '-d', '-s', 's1', '-c', '/home/u/app']);
  });

  it('says the directory is the problem when tmux cannot start there', async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '', timedOut: false });
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no such file or directory\n', timedOut: false });
    await expect(ensure({ session: 's1', cwd: '/gone' })).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('no such file') });
  });
});

describe('sendText', () => {
  it('types the text literally and sends Enter separately', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(sendText({ session: 's1', text: 'echo oi', enter: true })).resolves.toEqual({ sent: true });
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      ['send-keys', '-t', '=s1:', '-l', '--', 'echo oi'],
      ['send-keys', '-t', '=s1:', 'Enter'],
    ]);
  });

  it('sends only Enter when the text is empty', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendText({ session: 's1', text: '', enter: true });
    expect(run.mock.calls.map((c) => c[1])).toEqual([['send-keys', '-t', '=s1:', 'Enter']]);
  });

  it('reports a missing session instead of pretending it typed', async () => {
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "can't find pane", timedOut: false });
    await expect(sendText({ session: 's1', text: 'oi', enter: false })).rejects.toMatchObject({ code: 'notfound' });
  });

  it('pastes via a named tmux buffer instead of typing when paste is true, deletes it, then sends Enter separately', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(sendText({ session: 's1', text: 'linha um\nlinha dois', enter: true, paste: true })).resolves.toEqual({ sent: true });
    expect(run.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['tmux', ['load-buffer', '-b', 'termhub-paste-fixed-uuid', '-']],
      ['tmux', ['paste-buffer', '-p', '-d', '-b', 'termhub-paste-fixed-uuid', '-t', '=s1:']],
      ['tmux', ['delete-buffer', '-b', 'termhub-paste-fixed-uuid']],
      ['tmux', ['send-keys', '-t', '=s1:', 'Enter']],
    ]);
    // the text travels on stdin, never as an argv element or a shell string
    expect(run.mock.calls[0][2]).toMatchObject({ input: Buffer.from('linha um\nlinha dois') });
  });

  it('does not paste when paste is false (still the old send-keys -l -- path)', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendText({ session: 's1', text: 'oi', enter: false, paste: false });
    expect(run.mock.calls.map((c) => c[1])).toEqual([['send-keys', '-t', '=s1:', '-l', '--', 'oi']]);
  });

  it('does not paste when paste is absent (still the old send-keys -l -- path)', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendText({ session: 's1', text: 'oi', enter: false });
    expect(run.mock.calls.map((c) => c[1])).toEqual([['send-keys', '-t', '=s1:', '-l', '--', 'oi']]);
  });

  it('reports a missing session on paste too, when paste-buffer cannot find the pane, and still deletes the named buffer', async () => {
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false }); // load-buffer
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "can't find pane", timedOut: false }); // paste-buffer
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false }); // delete-buffer cleanup
    await expect(sendText({ session: 's1', text: 'oi', enter: false, paste: true })).rejects.toMatchObject({ code: 'notfound' });
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      ['load-buffer', '-b', 'termhub-paste-fixed-uuid', '-'],
      ['paste-buffer', '-p', '-d', '-b', 'termhub-paste-fixed-uuid', '-t', '=s1:'],
      ['delete-buffer', '-b', 'termhub-paste-fixed-uuid'],
    ]);
  });

  it('deletes the named buffer even when load-buffer itself fails', async () => {
    run.mockResolvedValueOnce({ code: null, stdout: '', stderr: '', timedOut: false, error: 'enoent' }); // load-buffer
    run.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false }); // delete-buffer cleanup
    await expect(sendText({ session: 's1', text: 'oi', enter: false, paste: true })).rejects.toMatchObject({ code: 'no_tmux' });
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      ['load-buffer', '-b', 'termhub-paste-fixed-uuid', '-'],
      ['delete-buffer', '-b', 'termhub-paste-fixed-uuid'],
    ]);
  });
});

describe('sendKey', () => {
  it('presses one key', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(sendKey({ session: 's1', key: 'C-c' })).resolves.toEqual({ sent: true });
    expect(run).toHaveBeenCalledWith('tmux', ['send-keys', '-t', '=s1:', 'C-c']);
  });
});

describe('scroll', () => {
  it('runs the shared scroll script with sh, tmux quoted, and answers done', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(scroll({ session: 's1', lines: -3 })).resolves.toEqual({ done: true });
    expect(sh).toHaveBeenCalledWith(buildScrollScript('s1', -3, shellQuote('tmux')));
    expect(run).not.toHaveBeenCalled();
  });

  it('uses TMUX_PATH, quoted, when it is set', async () => {
    process.env.TMUX_PATH = '/opt/my tmux/bin/tmux';
    sh.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await scroll({ session: 's1', lines: 0 });
    expect(sh).toHaveBeenCalledWith(buildScrollScript('s1', 0, "'/opt/my tmux/bin/tmux'"));
  });

  it('raises notfound with tmux\'s message when the script fails, timeout on a timeout', async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find session: s1\n", timedOut: false });
    await expect(scroll({ session: 's1', lines: 2 })).rejects.toMatchObject({ code: 'notfound', message: "can't find session: s1" });
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(scroll({ session: 's1', lines: 2 })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('foreground (TER-643)', () => {
  it('runs the shared pane script with sh, tmux quoted, and answers its word', async () => {
    sh.mockResolvedValue({ code: 0, stdout: 'shell\n', stderr: '', timedOut: false });
    await expect(foreground({ session: 's1' })).resolves.toEqual({ pane: 'shell' });
    expect(sh).toHaveBeenCalledWith(buildPaneForegroundScript('s1', shellQuote('tmux')));
    sh.mockResolvedValue({ code: 0, stdout: 'busy\n', stderr: '', timedOut: false });
    await expect(foreground({ session: 's1' })).resolves.toEqual({ pane: 'busy' });
  });

  it("raises notfound with tmux's message when the session is gone or the answer is not one of the words, timeout on a timeout", async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find session: s1\n", timedOut: false });
    await expect(foreground({ session: 's1' })).rejects.toMatchObject({ code: 'notfound', message: "can't find session: s1" });
    sh.mockResolvedValue({ code: 0, stdout: 'what\n', stderr: '', timedOut: false });
    await expect(foreground({ session: 's1' })).rejects.toMatchObject({ code: 'notfound' });
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(foreground({ session: 's1' })).rejects.toMatchObject({ code: 'timeout' });
  });
});
