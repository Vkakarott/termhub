import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * node-pty opens PTYs through a small prebuilt binary, `spawn-helper`. Its exec bit is set by
 * node-pty's postinstall — which npm 11 skips for packages the user has not approved — and
 * without it every spawn fails with the opaque "posix_spawnp failed.". The agent repairs that
 * itself so a fresh `npm i -g @termhub/agent` never needs a manual chmod.
 */

export interface SpawnHelperStatus {
  /** absolute path of the helper, or null when node-pty ships none for this platform (Linux prebuilds do not use it) */
  path: string | null;
  executable: boolean;
  /** true when this call flipped the exec bit */
  repaired: boolean;
  error?: string;
}

/** Locates node-pty's spawn-helper for this platform without loading the native module. */
export function findSpawnHelper(resolveFrom = import.meta.url): string | null {
  let pkgJson: string;
  try {
    pkgJson = createRequire(resolveFrom).resolve('node-pty/package.json');
  } catch {
    return null;
  }
  const root = path.dirname(pkgJson);
  const candidates = [
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(root, 'build', 'Release', 'spawn-helper'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const EXEC_BITS = 0o111;

/** Makes sure the helper is executable, fixing the mode when the file is ours to change. */
export function ensureSpawnHelperExecutable(helper: string | null = findSpawnHelper()): SpawnHelperStatus {
  if (!helper) return { path: null, executable: true, repaired: false };
  try {
    const mode = fs.statSync(helper).mode;
    if (mode & EXEC_BITS) return { path: helper, executable: true, repaired: false };
    fs.chmodSync(helper, (mode | 0o755) & 0o7777);
    return { path: helper, executable: true, repaired: true };
  } catch (err) {
    return { path: helper, executable: false, repaired: false, error: err instanceof Error ? err.message : String(err) };
  }
}
