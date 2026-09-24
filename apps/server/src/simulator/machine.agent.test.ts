import { beforeEach, describe, expect, it, vi } from 'vitest';

const { agentRpc, runOnMachine } = vi.hoisted(() => ({ agentRpc: vi.fn(), runOnMachine: vi.fn() }));
vi.mock('../agent/errors.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../agent/errors.js')>()), agentRpc }));
vi.mock('../terminal/machine-exec.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../terminal/machine-exec.js')>()), runOnMachine }));

import type { Machine } from '../db/repositories/types.js';
import { bootSimulator, listSimulators, runnerAlive, runnerTail, startRunner } from './machine.js';
import { startWdaSetup, wdaSetupState } from './setup.js';

const machine: Machine = { id: 'm1', name: 'mac', host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: ['xcodebuild', 'wda'], checked_at: null, owner_id: null, owner_name: null, created_at: '' };
const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';

beforeEach(() => {
  agentRpc.mockReset();
  runOnMachine.mockReset();
});

describe('simulator operations on an agent machine go through named rpcs, never runOnMachine', () => {
  it('listSimulators → sim.list, parsed on the server', async () => {
    agentRpc.mockResolvedValue({ stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [{ udid: UDID, name: 'iPhone 16e', state: 'Booted', isAvailable: true }] } }) });
    await expect(listSimulators(machine)).resolves.toEqual([{ udid: UDID, name: 'iPhone 16e', runtime: 'iOS 26.3', state: 'Booted' }]);
    expect(agentRpc).toHaveBeenCalledWith(machine, 'sim.list', {});
    expect(runOnMachine).not.toHaveBeenCalled();
  });
  it('bootSimulator → sim.boot; "already booted" is not a failure, "Invalid device" is', async () => {
    agentRpc.mockResolvedValue({ stdout: 'Unable to boot device in current state: Booted' });
    await expect(bootSimulator(machine, UDID)).resolves.toBeUndefined();
    expect(agentRpc).toHaveBeenCalledWith(machine, 'sim.boot', { udid: UDID });
    agentRpc.mockResolvedValue({ stdout: 'Invalid device: X' });
    await expect(bootSimulator(machine, UDID)).rejects.toThrow(/simctl boot falhou/);
    expect(runOnMachine).not.toHaveBeenCalled();
  });
  it('startRunner / runnerAlive / runnerTail → wda.runner.*', async () => {
    agentRpc.mockResolvedValue({ started: true });
    await startRunner(machine, UDID, { wdaPort: 8137, mjpegPort: 9137 });
    expect(agentRpc).toHaveBeenCalledWith(machine, 'wda.runner.start', { udid: UDID, wda_port: 8137, mjpeg_port: 9137 });
    agentRpc.mockResolvedValue({ alive: true });
    await expect(runnerAlive(machine, UDID)).resolves.toBe(true);
    expect(agentRpc).toHaveBeenCalledWith(machine, 'wda.runner.alive', { udid: UDID });
    agentRpc.mockResolvedValue({ lines: ['x', 'y'] });
    await expect(runnerTail(machine, UDID, 30)).resolves.toEqual(['x', 'y']);
    expect(agentRpc).toHaveBeenCalledWith(machine, 'wda.runner.tail', { udid: UDID, lines: 30 });
    expect(runOnMachine).not.toHaveBeenCalled();
  });
  it('wdaSetupState / startWdaSetup → wda.setup.*', async () => {
    agentRpc.mockResolvedValue({ stdout: 'STATE:idle\nVERSION:\nTAIL:\n' });
    await expect(wdaSetupState(machine)).resolves.toEqual({ state: 'idle', version: null, tail: [] });
    expect(agentRpc).toHaveBeenCalledWith(machine, 'wda.setup.state', {});
    agentRpc.mockReset();
    agentRpc.mockResolvedValueOnce({ stdout: 'STATE:idle\nVERSION:\nTAIL:\n' }).mockResolvedValueOnce({ started: true });
    await expect(startWdaSetup(machine)).resolves.toBeUndefined();
    expect(agentRpc).toHaveBeenLastCalledWith(machine, 'wda.setup.start', {});
    expect(runOnMachine).not.toHaveBeenCalled();
  });
  it('startWdaSetup answers 409 when the setup already runs', async () => {
    agentRpc.mockResolvedValue({ stdout: 'STATE:running\nVERSION:\nTAIL:\n' });
    await expect(startWdaSetup(machine)).rejects.toMatchObject({ statusCode: 409 });
  });
});
