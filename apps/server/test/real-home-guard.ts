import fs from 'node:fs';
import path from 'node:path';

/** Files under the home that the monitor-hooks / agent code writes; a test must never touch them. */
export const WATCHED_HOME_PATHS = [
  '.termhub/bin/termhub-hook',
  '.termhub/hook.env',
  '.termhub/config.json',
  '.termhub/tabs',
  '.claude/settings.json',
  '.codex/config.toml',
  '.codex/hooks.json',
  '.cursor/hooks.json',
];

/** Path -> "mtimeMs:size", or "absent". */
export type HomeSnapshot = Record<string, string>;

export function snapshotHome(home: string, rels: readonly string[] = WATCHED_HOME_PATHS): HomeSnapshot {
  const snap: HomeSnapshot = {};
  for (const rel of rels) {
    try {
      const st = fs.statSync(path.join(home, rel));
      snap[rel] = `${st.mtimeMs}:${st.size}`;
    } catch {
      snap[rel] = 'absent';
    }
  }
  return snap;
}

/** The relative paths whose state differs between the two snapshots (modified, created or removed). */
export function changedPaths(before: HomeSnapshot, after: HomeSnapshot): string[] {
  return Object.keys(before).filter((rel) => before[rel] !== after[rel]);
}
