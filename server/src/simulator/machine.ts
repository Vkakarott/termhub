import type { Machine } from '../db/repositories/types.js';
import { killTmuxSession, runOnMachine, shellQuote, type ExecResult } from '../terminal/machine-exec.js';
import { runnerSessionName, type WdaPorts } from './ports.js';

export const WDA_DIR = '$HOME/.termhub/WebDriverAgent';

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

const PATH_PREFIX = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';

/** Roda um script sh na máquina (local ou ssh) com o PATH de login. */
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

const UDID_RE = /^[A-Fa-f0-9-]{8,64}$/;
function assertUdid(udid: string): void {
  if (!UDID_RE.test(udid)) throw new Error(`UDID inválido: ${udid}`);
}

export async function listSimulators(machine: Machine): Promise<Simulator[]> {
  const r = await runScript(machine, 'xcrun simctl list devices -j');
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'falha ao listar simuladores');
  return parseSimctlList(r.stdout);
}

export async function bootSimulator(machine: Machine, udid: string): Promise<void> {
  assertUdid(udid);
  const r = await runScript(machine, `xcrun simctl boot ${udid} 2>&1 || true`, 60_000);
  const out = (r.stdout + r.stderr).toLowerCase();
  if (out.includes('unable to boot') || out.includes('invalid device')) throw new Error(`simctl boot falhou: ${(r.stdout + r.stderr).trim()}`);
}

export async function runnerAlive(machine: Machine, udid: string): Promise<boolean> {
  const name = runnerSessionName(udid);
  const r = await runScript(machine, `tmux has-session -t '=${name}' 2>/dev/null && echo yes || echo no`);
  return r.stdout.includes('yes');
}

export async function startRunner(machine: Machine, udid: string, ports: WdaPorts): Promise<void> {
  assertUdid(udid);
  const name = runnerSessionName(udid);
  const cmd =
    `cd ${WDA_DIR} && xcodebuild test-without-building -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner ` +
    `-destination id=${udid} -derivedDataPath DerivedData USE_PORT=${ports.wdaPort} MJPEG_SERVER_PORT=${ports.mjpegPort}`;
  const r = await runScript(machine, `tmux new-session -d -s ${name} ${shellQuote(cmd)}`);
  if (r.code !== 0 && !r.stderr.includes('duplicate session')) throw new Error(r.stderr.trim() || 'falha ao iniciar o runner do WDA');
}

export async function stopRunner(machine: Machine, udid: string): Promise<void> {
  await killTmuxSession(machine, runnerSessionName(udid));
}

export async function runnerTail(machine: Machine, udid: string, lines = 30): Promise<string[]> {
  const name = runnerSessionName(udid);
  const r = await runScript(machine, `tmux capture-pane -p -t '=${name}' 2>/dev/null | grep -v '^$' | tail -n ${lines}`);
  return r.stdout.split('\n').filter((l) => l.trim());
}
