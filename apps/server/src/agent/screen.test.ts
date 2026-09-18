import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import { config } from '../config.js';

const { runOnMachineMock } = vi.hoisted(() => ({ runOnMachineMock: vi.fn() }));

// Keep assertSessionName/REMOTE_PATH_PREFIX real (captureScreen calls the former directly, and
// builds the remote command string with the latter) — only runOnMachine is swapped out, so this
// suite exercises the real argv/remote-string captureScreen() builds without spawning anything.
vi.mock('../terminal/machine-exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal/machine-exec.js')>();
  return { ...actual, runOnMachine: runOnMachineMock };
});

import { captureScreen } from './screen.js';

function localMachine(): Machine {
  return {
    id: 'm1',
    name: 'local-box',
    host: null,
    ssh_user: null,
    ssh_port: 22,
    type: 'local',
    os: 'linux',
    capabilities: [],
    checked_at: null,
    agent_version: null,
    agent_last_seen_at: null,
    owner_id: null,
    owner_name: null,
    created_at: '',
  } as unknown as Machine;
}

function sshMachine(): Machine {
  return {
    id: 'm2',
    name: 'ssh-box',
    host: 'example.com',
    ssh_user: 'u',
    ssh_port: 22,
    type: 'ssh',
    os: 'linux',
    capabilities: [],
    checked_at: null,
    agent_version: null,
    agent_last_seen_at: null,
    owner_id: null,
    owner_name: null,
    created_at: '',
  } as unknown as Machine;
}

describe('captureScreen (local/ssh)', () => {
  beforeEach(() => {
    runOnMachineMock.mockReset();
  });

  it('local machine: capture-pane targets the exact session with a trailing colon', async () => {
    runOnMachineMock.mockResolvedValue({ code: 0, stdout: 'hello\n', stderr: '', timedOut: false });
    const text = await captureScreen(localMachine(), 'th-a', 500);
    expect(text).toBe('hello\n');
    expect(runOnMachineMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'local' }),
      { file: config.terminal.tmuxPath, args: ['capture-pane', '-p', '-S', '-500', '-t', '=th-a:'] },
      expect.any(String),
    );
  });

  it('ssh machine: the remote command string targets the exact session with a trailing colon', async () => {
    runOnMachineMock.mockResolvedValue({ code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    await captureScreen(sshMachine(), 'th-a', 500);
    const remoteCommand = runOnMachineMock.mock.calls[0]?.[2] as string;
    expect(remoteCommand).toContain(`capture-pane -p -S -500 -t '=th-a:'`);
  });

  it('clamps lines below 1 up to 1', async () => {
    runOnMachineMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await captureScreen(localMachine(), 'th-a', 0);
    expect(runOnMachineMock).toHaveBeenCalledWith(
      expect.anything(),
      { file: config.terminal.tmuxPath, args: ['capture-pane', '-p', '-S', '-1', '-t', '=th-a:'] },
      expect.any(String),
    );
  });

  it('clamps lines above 5000 down to 5000', async () => {
    runOnMachineMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await captureScreen(localMachine(), 'th-a', 9000);
    expect(runOnMachineMock).toHaveBeenCalledWith(
      expect.anything(),
      { file: config.terminal.tmuxPath, args: ['capture-pane', '-p', '-S', '-5000', '-t', '=th-a:'] },
      expect.any(String),
    );
  });

  it('a non-zero exit returns an empty string instead of throwing', async () => {
    runOnMachineMock.mockResolvedValue({ code: 1, stdout: 'ignored', stderr: 'boom', timedOut: false });
    const text = await captureScreen(localMachine(), 'th-a');
    expect(text).toBe('');
  });

  it('an invalid session name throws before ever calling runOnMachine', async () => {
    await expect(captureScreen(localMachine(), 'bad session!', 10)).rejects.toThrow();
    expect(runOnMachineMock).not.toHaveBeenCalled();
  });
});
