import { configDirPrefix } from '@termhub/machine-ops';
import type { Machine } from '../db/repositories/types.js';
import { runOnMachine } from '../terminal/machine-exec.js';
import type { AiCredential, AiProviderAdapter } from './types.js';

export class CredentialError extends Error {
  constructor(
    message: string,
    public hint: string | null = null,
  ) {
    super(message);
  }
}

/**
 * Reads the CLI credential from the machine and parses it. The raw output is
 * never logged; only the parsed token lives in memory for the duration of the request.
 */
export async function readCredential(machine: Machine, adapter: AiProviderAdapter, configDir: string | null, defaultDir: string): Promise<AiCredential> {
  let setD: string;
  try {
    setD = configDirPrefix(configDir, defaultDir);
  } catch (err) {
    throw new CredentialError(err instanceof Error ? err.message : 'Invalid config dir');
  }
  const script = `${setD}; ${adapter.credentialScript(configDir)}`;
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 10000);
  if (r.timedOut) throw new CredentialError('Machine did not answer in time');
  if (r.code !== 0) throw new CredentialError(machine.type === 'ssh' ? 'Machine unreachable over SSH' : 'Could not read the credential on the machine');
  const out = r.stdout.trim();
  if (!out) throw new CredentialError('No credential found on the machine', adapter.loginHint);
  try {
    return adapter.parseCredential(out);
  } catch (err) {
    throw new CredentialError(err instanceof Error ? err.message : 'Could not parse the credential', adapter.loginHint);
  }
}

/** Shared fetch with timeout; returns status + parsed JSON (or text). Never throws on HTTP errors. */
export async function httpJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: unknown; text: string }> {
  const { timeoutMs = 12000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** unix seconds/ms or ISO string -> ISO string */
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** "5 hours" / "7 days" from a window length in seconds. */
export function windowLabel(seconds: number | null): string | null {
  if (!seconds) return null;
  const h = Math.round(seconds / 3600);
  if (h < 24) return `${h} hora${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} dia${d === 1 ? '' : 's'}`;
}
