import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../exec.js';
import { RpcFailure } from '../exec.js';
import { type UpdateDeps, updateAgent } from './update.js';

const ok: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false, error: undefined };
const EXEC_PATH = '/opt/node/bin/node';
const NPM_CLI = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';

function deps(overrides: Partial<UpdateDeps> = {}): UpdateDeps & { run: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async () => ok),
    execPath: EXEC_PATH,
    npmCli: () => NPM_CLI,
    installedVersion: async () => '0.2.2',
    serviceInstalled: async () => true,
    exit: vi.fn(),
    log: vi.fn(),
    ...overrides,
  } as never;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('agent.update', () => {
  it('installs the requested version by running npm-cli.js with the running node (argv, no shell) and schedules an exit(1) when a service runs it', async () => {
    const d = deps();
    const r = await updateAgent({ version: '0.2.2' }, d);
    expect(d.run).toHaveBeenCalledWith(EXEC_PATH, [NPM_CLI, 'install', '-g', '--no-fund', '--no-audit', '@termhub/agent@0.2.2'], { timeoutMs: 150_000 });
    expect(r).toEqual({ installed_version: '0.2.2', restart: 'service' });
    expect(d.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(750);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('does not exit when no service is installed (manual restart)', async () => {
    const d = deps({ serviceInstalled: async () => false });
    const r = await updateAgent({ version: '0.2.2' }, d);
    expect(r.restart).toBe('manual');
    vi.advanceTimersByTime(2000);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('reports notfound when npm-cli.js cannot be found beside node, without running anything', async () => {
    const d = deps({ npmCli: () => null });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'notfound', message: 'npm not found beside node' });
    expect(d.run).not.toHaveBeenCalled();
  });

  it('reports notfound when npm itself is missing (ENOENT running node)', async () => {
    const d = deps({ run: vi.fn(async () => ({ ...ok, code: null, error: 'enoent' })) });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'notfound' });
  });

  it('reports failed with the exit code when npm fails, without logging npm output', async () => {
    const d = deps({ run: vi.fn(async () => ({ ...ok, code: 243, stderr: 'EACCES secret-path' })) });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'failed', message: 'npm exited with code 243' });
    expect(JSON.stringify(d.log.mock.calls)).not.toContain('secret-path');
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('reports failed when the installed version does not match', async () => {
    const d = deps({ installedVersion: async () => '0.2.0' });
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toBeInstanceOf(RpcFailure);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it('refuses a second update while one is running', async () => {
    let release!: () => void;
    const d = deps({ run: vi.fn(() => new Promise<RunResult>((res) => (release = () => res(ok)))) });
    const first = updateAgent({ version: '0.2.2' }, d);
    await expect(updateAgent({ version: '0.2.2' }, d)).rejects.toMatchObject({ code: 'failed', message: 'update already running' });
    release();
    await first;
  });
});
