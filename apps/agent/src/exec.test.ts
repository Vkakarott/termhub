import os from 'node:os';
import { REMOTE_PATH_PREFIX } from '@termhub/machine-ops';
import { describe, expect, it } from 'vitest';
import { agentEnv, run } from './exec.js';

// Real child processes throughout (no mocking): this file exercises exec.ts's own
// process-spawning behaviour, which the rpc/*.test.ts suites mock away.
describe('run', () => {
  it('resolves with timedOut:true (not a rejection) when the process is killed on the deadline', async () => {
    const r = await run('/bin/sh', ['-c', 'sleep 5'], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  }, 10_000);

  it('writes `input` to the child stdin and captures it back on stdout', async () => {
    const r = await run('/bin/sh', ['-c', 'cat'], { input: Buffer.from('abc') });
    expect(r.stdout).toBe('abc');
    expect(r.code).toBe(0);
  });

  it('does not crash the process on an EPIPE — child exits before reading a large stdin', async () => {
    // `exit 1` runs before /bin/sh ever reads stdin, so writing several MiB into the pipe
    // raises EPIPE on child.stdin; without an 'error' listener that throws and kills the
    // whole (single-process) agent. Getting a resolved result here is the regression check.
    const big = Buffer.alloc(4 * 1024 * 1024, 'x');
    const r = await run('/bin/sh', ['-c', 'exit 1'], { input: big });
    expect(r.code).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  it('marks a maxBuffer overflow with error:"maxbuffer" and a null code, not "enoent"', async () => {
    // `run()`'s cap is 8 MiB; produce more than that quickly.
    const r = await run('/bin/sh', ['-c', 'yes | head -c 10000000']);
    expect(r.code).toBeNull();
    expect(r.error).toBe('maxbuffer');
    expect(r.timedOut).toBe(false);
  }, 10_000);

  it('marks a missing binary with error:"enoent" and a null code', async () => {
    const r = await run('/definitely/not/a/real/binary-xyz', []);
    expect(r.code).toBeNull();
    expect(r.error).toBe('enoent');
    expect(r.timedOut).toBe(false);
  });

  it('reports a successful run with error left unset', async () => {
    const r = await run('/bin/sh', ['-c', 'echo hi']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi\n');
    expect(r.error).toBeUndefined();
  });
});

describe('agentEnv', () => {
  it("prefixes PATH with REMOTE_PATH_PREFIX's dirs (with $HOME expanded), derived not retyped", () => {
    const env = agentEnv({ PATH: '/usr/bin' });
    const m = REMOTE_PATH_PREFIX.match(/PATH="([^"]+):\$PATH"/);
    expect(m).not.toBeNull();
    const expectedPrefix = (m as RegExpMatchArray)[1].replace('$HOME', os.homedir());
    expect(env.PATH).toBe(`${expectedPrefix}:/usr/bin`);
  });
});
