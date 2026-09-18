import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Resolves `argv1` through the filesystem (following symlinks) before treating it as an
 * absolute path. `npm i -g @termhub/agent` installs a symlink in the global bin dir that points
 * at `dist/cli.js` — Node sets `process.argv[1]` to that symlink path, not the real target, so a
 * plain `path.resolve(argv1)` would store/compare against the symlink instead of the file it
 * points at. Falls back to the raw (non-realpath'd) resolved path if `realpathSync` itself fails
 * (e.g. the file was removed between spawn and this call) rather than throwing.
 */
export function resolveScriptPath(argv1: string | undefined): string {
  if (!argv1) return '';
  try {
    return realpathSync(argv1);
  } catch {
    return path.resolve(argv1);
  }
}

/**
 * True when this module is the process entry point (`node dist/cli.js`, or `tsx src/cli.ts` in
 * dev) — not merely imported by something else (e.g. `cli.test.ts` importing `main` directly).
 *
 * Compares against the *real* (symlink-resolved) path via `resolveScriptPath()`: Node sets
 * `import.meta.url` to the real target of a symlink, but leaves `process.argv[1]` as the
 * symlink itself when invoked through one (as `npm i -g`'s bin symlink does) — comparing the
 * raw, un-resolved `argv1` against `importMetaUrl` would then never match, silently turning the
 * installed CLI into a no-op.
 */
export function isMainModule(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  return importMetaUrl === pathToFileURL(resolveScriptPath(argv1)).href;
}
