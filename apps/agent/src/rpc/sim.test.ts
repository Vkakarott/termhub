import { SIMCTL_BOOT_SCRIPT, SIMCTL_LIST_SCRIPT } from '@termhub/machine-ops';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sh } = vi.hoisted(() => ({ sh: vi.fn() }));
vi.mock('../exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec.js')>();
  return { ...actual, sh };
});

import { boot, list } from './sim.js';

const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });

beforeEach(() => sh.mockReset());

describe('sim.list', () => {
  it('runs the constant simctl list script and passes stdout through', async () => {
    sh.mockResolvedValue(ok('{"devices":{}}'));
    await expect(list({})).resolves.toEqual({ stdout: '{"devices":{}}' });
    expect(sh).toHaveBeenCalledWith(SIMCTL_LIST_SCRIPT, expect.objectContaining({ timeoutMs: 14_000 }));
  });
  it('reports a timeout and a non-zero exit as failed with the machine message', async () => {
    sh.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(list({})).rejects.toMatchObject({ code: 'timeout' });
    sh.mockResolvedValue({ code: 1, stdout: '', stderr: 'xcrun: error: unable to find utility "simctl"', timedOut: false });
    await expect(list({})).rejects.toMatchObject({ code: 'failed', message: 'xcrun: error: unable to find utility "simctl"' });
  });
});

describe('sim.boot', () => {
  it('passes the udid through the environment, never the script text', async () => {
    sh.mockResolvedValue(ok(''));
    await expect(boot({ udid: UDID })).resolves.toEqual({ stdout: '' });
    const [script, opts] = sh.mock.calls[0];
    expect(script).toBe(SIMCTL_BOOT_SCRIPT);
    expect(script).not.toContain(UDID);
    expect(opts.env.UDID).toBe(UDID);
    expect(opts.env.PATH).toContain('/opt/homebrew/bin');
    expect(opts.timeoutMs).toBe(59_000);
  });
  it('rejects an invalid udid before running anything', async () => {
    await expect(boot({ udid: 'x; rm -rf /' })).rejects.toMatchObject({ code: 'invalid' });
    expect(sh).not.toHaveBeenCalled();
  });
  it('returns combined stdout+stderr so the server can read "already booted"', async () => {
    sh.mockResolvedValue({ code: 0, stdout: '', stderr: 'Unable to boot device in current state: Booted', timedOut: false });
    await expect(boot({ udid: UDID })).resolves.toEqual({ stdout: 'Unable to boot device in current state: Booted' });
  });
});
