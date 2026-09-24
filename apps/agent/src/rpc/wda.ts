import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { isWdaPort } from '@termhub/agent-protocol';
import {
  WDA_RUNNER_ALIVE_SCRIPT,
  WDA_RUNNER_START_SCRIPT,
  WDA_RUNNER_TAIL_SCRIPT,
  WDA_SETUP_START_SCRIPT,
  WDA_SETUP_STATE_SCRIPT,
  runnerSessionName,
} from '@termhub/machine-ops';
import { RpcFailure, agentEnv, sh } from '../exec.js';
import { checkUdid, scriptFailure } from './sim.js';

function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...agentEnv(), ...vars };
}

export async function runnerStart(params: RpcParams<'wda.runner.start'>): Promise<RpcResult<'wda.runner.start'>> {
  checkUdid(params.udid);
  if (!isWdaPort(params.wda_port) || !isWdaPort(params.mjpeg_port)) throw new RpcFailure('invalid', 'port outside the WDA ranges');
  const vars = { SESSION: runnerSessionName(params.udid), UDID: params.udid, WDA_PORT: String(params.wda_port), MJPEG_PORT: String(params.mjpeg_port) };
  const r = await sh(WDA_RUNNER_START_SCRIPT, { timeoutMs: 9_000, env: env(vars) });
  if (r.code !== 0 && r.stderr.includes('duplicate session')) return { started: false };
  const failure = scriptFailure(r, 'wda.runner.start');
  if (failure) throw failure;
  return { started: true };
}

export async function runnerAlive(params: RpcParams<'wda.runner.alive'>): Promise<RpcResult<'wda.runner.alive'>> {
  checkUdid(params.udid);
  const r = await sh(WDA_RUNNER_ALIVE_SCRIPT, { env: env({ SESSION: runnerSessionName(params.udid) }) });
  const failure = scriptFailure(r, 'wda.runner.alive');
  if (failure) throw failure;
  return { alive: r.stdout.includes('yes') };
}

export async function runnerTail(params: RpcParams<'wda.runner.tail'>): Promise<RpcResult<'wda.runner.tail'>> {
  checkUdid(params.udid);
  const r = await sh(WDA_RUNNER_TAIL_SCRIPT, { env: env({ SESSION: runnerSessionName(params.udid), LINES: String(params.lines) }) });
  const failure = scriptFailure(r, 'wda.runner.tail');
  if (failure) throw failure;
  return { lines: r.stdout.split('\n').filter((l) => l.trim()) };
}

export async function setupStart(_params: RpcParams<'wda.setup.start'>): Promise<RpcResult<'wda.setup.start'>> {
  const r = await sh(WDA_SETUP_START_SCRIPT, { timeoutMs: 9_000 });
  const failure = scriptFailure(r, 'wda.setup.start');
  if (failure) throw failure;
  if (r.stdout.includes('STARTED:no')) return { started: false };
  if (r.stdout.includes('STARTED:yes')) return { started: true };
  throw new RpcFailure('failed', r.stderr.trim().split('\n')[0] || 'setup did not start');
}

export async function setupState(_params: RpcParams<'wda.setup.state'>): Promise<RpcResult<'wda.setup.state'>> {
  const r = await sh(WDA_SETUP_STATE_SCRIPT);
  const failure = scriptFailure(r, 'wda.setup.state');
  if (failure) throw failure;
  return { stdout: r.stdout };
}
