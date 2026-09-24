import { WDA_RUNNER_ALIVE_SCRIPT, WDA_RUNNER_START_SCRIPT, WDA_RUNNER_TAIL_SCRIPT, WDA_SETUP_START_SCRIPT, WDA_SETUP_STATE_SCRIPT } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { runnerAlive, runnerStart, runnerTail, setupStart, setupState } from './wda.js';

const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
const SESSION = 'termhub-wda-bae07eb5';
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });

beforeEach(() => sh.mockReset());

describe('wda.runner.start', () => {
  it('runs the constant script with SESSION/UDID/WDA_PORT/MJPEG_PORT in the environment', async () => {
    sh.mockResolvedValue(ok(''));
    await expect(runnerStart({ udid: UDID, wda_port: 8137, mjpeg_port: 9137 })).resolves.toEqual({ started: true });
    const [script, opts] = sh.mock.calls[0];
    expect(script).toBe(WDA_RUNNER_START_SCRIPT);
    expect(opts.env).toEqual(expect.objectContaining({ SESSION, UDID, WDA_PORT: '8137', MJPEG_PORT: '9137' }));
  });
  it('reports started: false when the tmux session already exists', async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: `duplicate session: ${SESSION}`, timedOut: false });
    await expect(runnerStart({ udid: UDID, wda_port: 8137, mjpeg_port: 9137 })).resolves.toEqual({ started: false });
  });
  it('rejects ports outside the WDA ranges and bad udids before running', async () => {
    await expect(runnerStart({ udid: UDID, wda_port: 8200, mjpeg_port: 9137 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(runnerStart({ udid: 'nope!', wda_port: 8137, mjpeg_port: 9137 })).rejects.toMatchObject({ code: 'invalid' });
    expect(sh).not.toHaveBeenCalled();
  });
  it('maps tmux missing to no_tmux and any other failure to failed', async () => {
    sh.mockResolvedValue({ code: 127, stdout: '', stderr: 'sh: tmux: command not found', timedOut: false });
    await expect(runnerStart({ udid: UDID, wda_port: 8137, mjpeg_port: 9137 })).rejects.toMatchObject({ code: 'no_tmux' });
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: 'boom', timedOut: false });
    await expect(runnerStart({ udid: UDID, wda_port: 8137, mjpeg_port: 9137 })).rejects.toMatchObject({ code: 'failed', message: 'boom' });
  });
});

describe('wda.runner.alive / tail', () => {
  it('alive reads yes/no', async () => {
    sh.mockResolvedValue(ok('yes\n'));
    await expect(runnerAlive({ udid: UDID })).resolves.toEqual({ alive: true });
    expect(sh.mock.calls[0][0]).toBe(WDA_RUNNER_ALIVE_SCRIPT);
    expect(sh.mock.calls[0][1].env.SESSION).toBe(SESSION);
    sh.mockResolvedValue(ok('no\n'));
    await expect(runnerAlive({ udid: UDID })).resolves.toEqual({ alive: false });
  });
  it('tail passes LINES and splits non-empty lines', async () => {
    sh.mockResolvedValue(ok('a\n\nb\n'));
    await expect(runnerTail({ udid: UDID, lines: 30 })).resolves.toEqual({ lines: ['a', 'b'] });
    expect(sh.mock.calls[0][0]).toBe(WDA_RUNNER_TAIL_SCRIPT);
    expect(sh.mock.calls[0][1].env).toEqual(expect.objectContaining({ SESSION, LINES: '30' }));
  });
});

describe('wda.setup.start / state', () => {
  it('start reads STARTED:yes|no', async () => {
    sh.mockResolvedValue(ok('STARTED:yes\n'));
    await expect(setupStart({})).resolves.toEqual({ started: true });
    expect(sh.mock.calls[0][0]).toBe(WDA_SETUP_START_SCRIPT);
    sh.mockResolvedValue(ok('STARTED:no\n'));
    await expect(setupStart({})).resolves.toEqual({ started: false });
  });
  it('start without a STARTED line is a failure with the machine message', async () => {
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: 'no space left', timedOut: false });
    await expect(setupStart({})).rejects.toMatchObject({ code: 'failed', message: 'no space left' });
  });
  it('state passes stdout through', async () => {
    sh.mockResolvedValue(ok('STATE:idle\nVERSION:\nTAIL:\n'));
    await expect(setupState({})).resolves.toEqual({ stdout: 'STATE:idle\nVERSION:\nTAIL:\n' });
    expect(sh.mock.calls[0][0]).toBe(WDA_SETUP_STATE_SCRIPT);
  });
});
