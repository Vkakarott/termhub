import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, run };
});

import { capture, ensure, kill, list, sendKey, sendText } from './tmux.js';

beforeEach(() => {
  run.mockReset();
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
});

describe('sendKey', () => {
  it('presses one key', async () => {
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await expect(sendKey({ session: 's1', key: 'C-c' })).resolves.toEqual({ sent: true });
    expect(run).toHaveBeenCalledWith('tmux', ['send-keys', '-t', '=s1:', 'C-c']);
  });
});
