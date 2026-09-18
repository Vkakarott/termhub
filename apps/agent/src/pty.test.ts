import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSocket } from './client.js';
import * as execModule from './exec.js';
import { createPtyManager, type SpawnFn, type PtyLike } from './pty.js';

function makeSocket(): { socket: AgentSocket; sendControl: ReturnType<typeof vi.fn>; sendStream: ReturnType<typeof vi.fn> } {
  const sendControl = vi.fn();
  const sendStream = vi.fn();
  return { socket: { sendControl, sendStream }, sendControl, sendStream };
}

/** A fake node-pty process the tests fully control: capture the wired-up callbacks so tests can emit data/exit. */
function makeFakePty(): { proc: PtyLike; emitData: (s: string) => void; emitExit: (exitCode: number, signal?: number) => void; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  let dataCb: ((s: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const write = vi.fn();
  const resize = vi.fn();
  const kill = vi.fn();
  const proc: PtyLike = {
    pid: 4242,
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    write,
    resize,
    kill,
  };
  return {
    proc,
    emitData: (s) => dataCb?.(s),
    emitExit: (exitCode, signal) => exitCb?.({ exitCode, signal }),
    write,
    resize,
    kill,
  };
}

const openParams = { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 };

describe('createPtyManager', () => {
  it('sends opened and spawns tmux with the exact argv (including -A)', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(1, openParams, socket);

    expect(spawn).toHaveBeenCalledWith('tmux', ['-u', 'new-session', '-A', '-s', 'th-a', '-c', '/tmp'], expect.objectContaining({ name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp' }));
    expect(sendControl).toHaveBeenCalledWith({ type: 'opened', ch: 1 });
  });

  it('spawns with a UTF-8 env carrying TERM, LANG, TERMHUB and the tab id', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(2, openParams, socket);

    const call = spawn.mock.calls[0]!;
    const env = call[2].env as Record<string, string>;
    expect(env.TERM).toBe('xterm-256color');
    expect(env.LANG).toMatch(/utf-?8/i);
    expect(env.TERMHUB).toBe('1');
    expect(env.TERMHUB_TAB_ID).toBe('th-a');
    expect(env.TERMHUB_SESSION).toBe('th-a');
  });

  it('forwards data from the fake pty as stream bytes on the channel', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendStream } = makeSocket();

    await manager.open(3, openParams, socket);
    fake.emitData('hello');

    expect(sendStream).toHaveBeenCalledWith(3, Buffer.from('hello', 'utf8'));
  });

  it('write() forwards to the underlying pty as utf8', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(4, openParams, socket);
    manager.write(4, Buffer.from('ls\n', 'utf8'));

    expect(fake.write).toHaveBeenCalledWith('ls\n');
  });

  it('resize() clamps and forwards to the underlying pty', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(5, openParams, socket);
    manager.resize(5, 1000, 1);

    expect(fake.resize).toHaveBeenCalledWith(500, 2);
  });

  it('sends closed with the exit code exactly once, even after close() was called', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(6, openParams, socket);
    sendControl.mockClear();
    manager.close(6);
    fake.emitExit(0);

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'closed' }));
  });

  it('sends closed with the exit code when the process exits on its own', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(7, openParams, socket);
    fake.emitExit(17);

    expect(sendControl).toHaveBeenCalledWith({ type: 'closed', ch: 7, code: 17 });
  });

  it('open_error no_tmux when spawn throws ENOENT', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      const err = new Error('spawn tmux ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(8, openParams, socket);

    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 8, error: { code: 'no_tmux', message: 'tmux not found' } });
  });

  it('open_error internal when spawn throws something else', async () => {
    const spawn = vi.fn<SpawnFn>(() => {
      throw new Error('boom');
    });
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(9, openParams, socket);

    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 9, error: { code: 'internal', message: 'failed to start pty' } });
  });

  it('open_error internal (and resolves, never rejects) when building the env throws before spawn is even reached', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    // Regression for a bug where `agentEnv()` (called while building the pty env, before the
    // try/catch around spawn) could throw synchronously — e.g. a malformed REMOTE_PATH_PREFIX
    // in agentEnv()'s pathPrefixDirs() — and that exception escaped open() entirely instead of
    // being reported as open_error, leaving the channel with neither `opened` nor `open_error`.
    const agentEnvSpy = vi.spyOn(execModule, 'agentEnv').mockImplementation(() => {
      throw new Error('unexpected REMOTE_PATH_PREFIX format');
    });

    await expect(manager.open(13, openParams, socket)).resolves.toBeUndefined();

    agentEnvSpy.mockRestore();
    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 13, error: { code: 'internal', message: 'failed to start pty' } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('open_error invalid when the channel is already open', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket, sendControl } = makeSocket();

    await manager.open(10, openParams, socket);
    sendControl.mockClear();
    await manager.open(10, openParams, socket);

    expect(sendControl).toHaveBeenCalledWith({ type: 'open_error', ch: 10, error: { code: 'invalid', message: 'channel in use' } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('write/resize/close on an unknown channel are no-ops', () => {
    const spawn = vi.fn<SpawnFn>();
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });

    expect(() => manager.write(99, Buffer.from('x'))).not.toThrow();
    expect(() => manager.resize(99, 80, 24)).not.toThrow();
    expect(() => manager.close(99)).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('closeAll kills every open proc', async () => {
    const fakeA = makeFakePty();
    const fakeB = makeFakePty();
    let call = 0;
    const spawn = vi.fn<SpawnFn>(() => (call++ === 0 ? fakeA.proc : fakeB.proc));
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(1, openParams, socket);
    await manager.open(2, { ...openParams, session: 'th-b' }, socket);
    manager.closeAll();

    expect(fakeA.kill).toHaveBeenCalledTimes(1);
    expect(fakeB.kill).toHaveBeenCalledTimes(1);
  });

  it('expands a leading ~ cwd against HOME', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(11, { ...openParams, cwd: '~' }, socket);

    const call = spawn.mock.calls[0]!;
    expect(call[2].cwd).toBe(os.homedir());
  });

  it('falls back to HOME when cwd does not exist', async () => {
    const fake = makeFakePty();
    const spawn = vi.fn<SpawnFn>(() => fake.proc);
    const manager = createPtyManager({ spawn, tmuxPath: 'tmux', log: vi.fn() });
    const { socket } = makeSocket();

    await manager.open(12, { ...openParams, cwd: '/does/not/exist/at/all' }, socket);

    const call = spawn.mock.calls[0]!;
    expect(call[2].cwd).toBe(process.env.HOME || '/');
  });
});
