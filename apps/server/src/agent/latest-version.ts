import { httpJson } from '../ai/credentials.js';
import { versionAtLeast } from './errors.js';

/**
 * Which @termhub/agent is the newest on npm, so the UI can offer an update and the auto-update
 * scheduler (below, Task 5) knows what to install. One process-wide cache, refreshed hourly;
 * null until the registry answered once (the UI then shows nothing).
 */
export const AGENT_PACKAGE = '@termhub/agent';
const REGISTRY_URL = `https://registry.npmjs.org/${AGENT_PACKAGE}/latest`;
export const REFRESH_MS = 60 * 60 * 1000;
const FIRST_FETCH_DELAY_MS = 2_000;
/** First agent that knows the agent.update RPC. */
export const MIN_SELF_UPDATE_VERSION = '0.2.1';
const SEMVER = /^\d+\.\d+\.\d+$/;

type FetchJson = typeof httpJson;
export interface VersionLog {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
}

let cached: string | null = null;

export function latestAgentVersion(): string | null {
  return cached;
}

/** Tests only. */
export function setLatestAgentVersion(v: string | null): void {
  cached = v;
}

/** True when both are plain x.y.z and `current` is older than `latest`. */
export function isOutdated(current: string | null | undefined, latest: string | null): boolean {
  if (!current || !latest || !SEMVER.test(current) || !SEMVER.test(latest)) return false;
  return !versionAtLeast(current, latest);
}

export async function fetchLatestAgentVersion(fetchJson: FetchJson = httpJson): Promise<string | null> {
  try {
    const r = await fetchJson(REGISTRY_URL, { headers: { accept: 'application/json' }, timeoutMs: 10_000 });
    if (r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
    const v = (r.body as { version?: unknown }).version;
    return typeof v === 'string' && SEMVER.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Fetches shortly after boot and then every REFRESH_MS; `onRefresh` runs after each successful fetch. Returns a stop function. */
export function startAgentVersionPoller(log: VersionLog, onRefresh?: () => Promise<void>, fetchJson: FetchJson = httpJson): () => void {
  const tick = async () => {
    const v = await fetchLatestAgentVersion(fetchJson);
    if (!v) {
      log.warn({ package: AGENT_PACKAGE }, 'npm registry: could not read the latest agent version');
      return;
    }
    if (v !== cached) log.info({ version: v }, 'latest agent version on npm');
    cached = v;
    try {
      await onRefresh?.();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'agent version refresh hook failed');
    }
  };
  const timer = setInterval(() => void tick(), REFRESH_MS);
  timer.unref();
  const first = setTimeout(() => void tick(), FIRST_FETCH_DELAY_MS);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
