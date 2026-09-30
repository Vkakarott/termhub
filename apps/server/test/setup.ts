import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { setPublicIdKey } from '../src/public/public-id.js';
import { changedPaths, snapshotHome, type HomeSnapshot } from './real-home-guard.js';

/**
 * In production the key behind `publicId` is loaded from the database before the server listens
 * (`buildApp`). Tests never boot that far, so every test file starts with this fixed one instead.
 */
export const TEST_PUBLIC_ID_KEY = Buffer.alloc(32, 42);
setPublicIdKey(TEST_PUBLIC_ID_KEY);

/**
 * Server tests must never write to the developer's real home.
 *
 * Incident (TER-491): `agent/e2e.test.ts` and `simulator/agent-tunnel.e2e.test.ts` run the real
 * agent in-process, and `runAgent` heals the monitor hooks of the HOME it runs in. On a machine
 * with termhub hooks installed, a local `vitest run` rewrote the real `~/.termhub/bin/termhub-hook`
 * and merged our entries into the real `~/.codex/hooks.json`. Nothing failed, so nobody noticed.
 *
 * Two layers, both loaded before every test file:
 *  - `$HOME` points at a fresh temp dir per file (`os.homedir()` and child processes read it), so
 *    code that resolves `~` lands in a sandbox;
 *  - the hook files termhub's installer/heal writes under the REAL home are snapshotted, and a
 *    change fails the file: that catches code that bypasses `$HOME` (hardcoded paths,
 *    `os.userInfo()`).
 *
 * The redirect happens at module level, not in `beforeAll`: test files are imported (and their
 * `describe` bodies collected) before any hook runs, so an `os.homedir()` evaluated at import time
 * would still see the real home.
 */
const REAL_HOME = os.homedir(); // captured once, before HOME is redirected
const previousHome = process.env.HOME;
const homeBefore: HomeSnapshot = snapshotHome(REAL_HOME);
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'th-server-test-home-'));
process.env.HOME = sandboxHome;

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(sandboxHome, { recursive: true, force: true });
  const changed = changedPaths(homeBefore, snapshotHome(REAL_HOME));
  if (changed.length > 0) {
    throw new Error(
      `a test wrote to the real HOME: ${changed.join(', ')} (a live termhub-agent restarting or updating during the run also rewrites these: re-run to confirm)`,
    );
  }
});
