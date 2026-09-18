import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, run };
});

import { capture, kill, list } from './tmux.js';

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

  it('tmux.list raises no_tmux when the binary could not be spawned', async () => {
    run.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: false });
    await expect(list({})).rejects.toMatchObject({ code: 'no_tmux' });
  });

  it('tmux.list raises timeout when the process is killed on the deadline', async () => {
    run.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
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
    expect(run).toHaveBeenCalledWith('tmux', ['capture-pane', '-p', '-S', '-200', '-t', '=th-a']);
  });

  it('tmux.capture raises notfound on a non-zero exit', async () => {
    run.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find session th-a", timedOut: false });
    await expect(capture({ session: 'th-a', lines: 200 })).rejects.toMatchObject({ code: 'notfound' });
  });

  it('respects a TMUX_PATH override for every method', async () => {
    process.env.TMUX_PATH = '/custom/tmux';
    run.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await kill({ session: 'th-a' });
    expect(run).toHaveBeenCalledWith('/custom/tmux', ['kill-session', '-t', '=th-a']);
  });
});
