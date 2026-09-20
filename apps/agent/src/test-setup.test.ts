import { describe, expect, it } from 'vitest';
import { run } from './exec.js';
import { stopRestartLoop } from './service/launchd.js';
import { takeServiceManagerViolations } from './test-setup.js';

describe('test-setup service-manager guard', () => {
  it('rejects a real launchctl spawn through exec.run()', async () => {
    await expect(run('launchctl', ['print', 'gui/0/dev.termhub.agent'])).rejects.toThrow(/real service manager/);
    expect(takeServiceManagerViolations()).toEqual(['launchctl print gui/0/dev.termhub.agent']);
  });

  it('rejects systemctl too, by basename', async () => {
    await expect(run('/usr/bin/systemctl', ['--user', 'is-active', 'x'])).rejects.toThrow(/real service manager/);
    expect(takeServiceManagerViolations()).toHaveLength(1);
  });

  it('records the attempt even when the caller swallows the error (stopRestartLoop is best-effort)', async () => {
    await stopRestartLoop({ platform: 'darwin' });
    expect(takeServiceManagerViolations()).toEqual([expect.stringMatching(/^launchctl bootout gui\/\d+\/dev\.termhub\.agent$/)]);
  });

  it('leaves other binaries alone', async () => {
    const r = await run('true', []);
    expect(r.code).toBe(0);
    expect(takeServiceManagerViolations()).toEqual([]);
  });
});
