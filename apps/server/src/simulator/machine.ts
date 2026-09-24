import {
  SIMCTL_BOOT_SCRIPT,
  SIMCTL_LIST_SCRIPT,
  WDA_RUNNER_ALIVE_SCRIPT,
  WDA_RUNNER_START_SCRIPT,
  WDA_RUNNER_TAIL_SCRIPT,
  assertUdid,
  runnerSessionName,
  withVars,
} from '@termhub/machine-ops';
import type { Machine } from '../db/repositories/types.js';
import { agentRpc } from '../agent/errors.js';
import { killTmuxSession, runOnMachine, type ExecResult } from '../terminal/machine-exec.js';
import type { WdaPorts } from './ports.js';

export { WDA_DIR } from '@termhub/machine-ops';

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

const PATH_PREFIX = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';

/** Runs a sh script on a local/ssh machine with the login PATH. */
export function runScript(machine: Machine, script: string, timeoutMs = 15_000): Promise<ExecResult> {
  const full = PATH_PREFIX + script;
  return runOnMachine(machine, { file: '/bin/sh', args: ['-lc', full] }, full, timeoutMs);
}

/** `xcrun simctl list devices -j` → lista plana, só disponíveis, bootados primeiro. */
export function parseSimctlList(json: string): Simulator[] {
  let data: { devices?: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> };
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const out: Simulator[] = [];
  for (const [runtimeId, devices] of Object.entries(data.devices ?? {})) {
    // com.apple.CoreSimulator.SimRuntime.iOS-26-3 → iOS 26.3
    const short = runtimeId.replace(/^.*SimRuntime\./, '');
    const runtime = short.replace(/^([A-Za-z]+)-(\d+)-(\d+)$/, '$1 $2.$3').replace(/-/g, ' ');
    for (const d of devices) {
      if (d.isAvailable === false) continue;
      out.push({ udid: d.udid, name: d.name, runtime, state: d.state });
    }
  }
  const rank = (s: string) => (s === 'Booted' ? 0 : 1);
  return out.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

/** `xcrun simctl boot` já bootado devolve "current state: Booted" (sucesso); trata como falha só os demais casos. */
export function isBootFailure(output: string): boolean {
  const out = output.toLowerCase();
  if (out.includes('current state: booted')) return false;
  return out.includes('unable to boot') || out.includes('invalid device') || out.includes('invalid device state');
}

export async function listSimulators(machine: Machine): Promise<Simulator[]> {
  if (machine.type === 'agent') {
    const { stdout } = await agentRpc(machine, 'sim.list', {});
    return parseSimctlList(stdout);
  }
  const r = await runScript(machine, SIMCTL_LIST_SCRIPT);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'falha ao listar simuladores');
  return parseSimctlList(r.stdout);
}

export async function bootSimulator(machine: Machine, udid: string): Promise<void> {
  assertUdid(udid);
  if (machine.type === 'agent') {
    const { stdout } = await agentRpc(machine, 'sim.boot', { udid });
    if (isBootFailure(stdout)) throw new Error(`simctl boot falhou: ${stdout.trim()}`);
    return;
  }
  const r = await runScript(machine, withVars({ UDID: udid }, SIMCTL_BOOT_SCRIPT), 60_000);
  const out = r.stdout + r.stderr;
  if (isBootFailure(out)) throw new Error(`simctl boot falhou: ${out.trim()}`);
}

export async function runnerAlive(machine: Machine, udid: string): Promise<boolean> {
  assertUdid(udid);
  if (machine.type === 'agent') return (await agentRpc(machine, 'wda.runner.alive', { udid })).alive;
  const r = await runScript(machine, withVars({ SESSION: runnerSessionName(udid) }, WDA_RUNNER_ALIVE_SCRIPT));
  return r.stdout.includes('yes');
}

export async function startRunner(machine: Machine, udid: string, ports: WdaPorts): Promise<void> {
  assertUdid(udid);
  if (machine.type === 'agent') {
    await agentRpc(machine, 'wda.runner.start', { udid, wda_port: ports.wdaPort, mjpeg_port: ports.mjpegPort });
    return;
  }
  const vars = { SESSION: runnerSessionName(udid), UDID: udid, WDA_PORT: String(ports.wdaPort), MJPEG_PORT: String(ports.mjpegPort) };
  const r = await runScript(machine, withVars(vars, WDA_RUNNER_START_SCRIPT));
  if (r.code !== 0 && !r.stderr.includes('duplicate session')) throw new Error(r.stderr.trim() || 'falha ao iniciar o runner do WDA');
}

export async function stopRunner(machine: Machine, udid: string): Promise<void> {
  assertUdid(udid);
  await killTmuxSession(machine, runnerSessionName(udid));
}

export async function runnerTail(machine: Machine, udid: string, lines = 30): Promise<string[]> {
  assertUdid(udid);
  if (machine.type === 'agent') return (await agentRpc(machine, 'wda.runner.tail', { udid, lines })).lines;
  const r = await runScript(machine, withVars({ SESSION: runnerSessionName(udid), LINES: String(lines) }, WDA_RUNNER_TAIL_SCRIPT));
  return r.stdout.split('\n').filter((l) => l.trim());
}
