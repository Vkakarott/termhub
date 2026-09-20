/**
 * Loaded before every agent test file (vitest `setupFiles`).
 *
 * The agent's service layer has real side effects on the developer's machine: `launchctl
 * bootout gui/<uid>/dev.termhub.agent` SIGTERMs the agent that serves this very machine's tabs
 * and unloads it, and `install()`/`uninstall()` write/delete a file under the real home. A test
 * that reaches them unmocked kills the developer's own agent — which is exactly what happened:
 * `cli.test.ts` (`main(['run'])` without a config → `stopRestartLoop()` → real bootout) and
 * `service.test.ts` (real plist overwritten, then unlinked). This guard turns any such spawn
 * into a test failure instead of a silently dead service.
 *
 * Only launchctl/systemctl are blocked; tmux, npm and the other binaries tests run stay real.
 */
import { afterEach, vi } from 'vitest';

const SERVICE_MANAGERS = /(^|\/)(launchctl|systemctl)$/;

const violations: string[] = [];

function guard(file: unknown, args: unknown): void {
  if (typeof file !== 'string' || !SERVICE_MANAGERS.test(file)) return;
  const call = `${file} ${Array.isArray(args) ? args.join(' ') : ''}`.trim();
  violations.push(call);
  throw new Error(`test tried to run the real service manager: "${call}" — inject a fake \`run\` (see service.test.ts) or mock stopRestartLoop`);
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const wrap = <F extends (...a: never[]) => unknown>(fn: F): F =>
    ((...a: unknown[]) => {
      guard(a[0], a[1]);
      return (fn as unknown as (...x: unknown[]) => unknown)(...a);
    }) as unknown as F;
  return {
    ...actual,
    execFile: wrap(actual.execFile),
    execFileSync: wrap(actual.execFileSync),
    spawn: wrap(actual.spawn),
    spawnSync: wrap(actual.spawnSync),
  };
});

/** Drains the recorded violations (for the guard's own test). */
export function takeServiceManagerViolations(): string[] {
  return violations.splice(0);
}

// A caller that swallows the guard's error (e.g. `stopRestartLoop()`'s best-effort try/catch)
// would otherwise pass silently: surface the attempt at the end of the test regardless.
afterEach(() => {
  if (violations.length === 0) return;
  const calls = violations.splice(0);
  throw new Error(`test reached the real service manager: ${calls.join('; ')}`);
});
