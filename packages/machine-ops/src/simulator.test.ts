import { describe, expect, it } from 'vitest';
import {
  SIMCTL_BOOT_SCRIPT,
  SIMCTL_LIST_SCRIPT,
  UDID_RE,
  WDA_DIR,
  WDA_RUNNER_ALIVE_SCRIPT,
  WDA_RUNNER_START_SCRIPT,
  WDA_RUNNER_TAIL_SCRIPT,
  WDA_SETUP_SESSION,
  WDA_SETUP_SH,
  WDA_SETUP_START_SCRIPT,
  WDA_SETUP_STATE_SCRIPT,
  assertUdid,
  runnerSessionName,
  withVars,
} from './simulator.js';

const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';

describe('udid and session names', () => {
  it('accepts simctl udids and rejects shell syntax', () => {
    expect(UDID_RE.test(UDID)).toBe(true);
    expect(() => assertUdid(UDID)).not.toThrow();
    expect(() => assertUdid('abc; rm -rf /')).toThrow(/UDID/);
    expect(() => assertUdid('')).toThrow();
  });
  it('derives the tmux session name from the first 8 chars of the udid, lowercased', () => {
    expect(runnerSessionName(UDID)).toBe('termhub-wda-bae07eb5');
  });
});

describe('withVars', () => {
  it('prefixes shell assignments, single-quoted, before the script', () => {
    expect(withVars({ UDID: UDID, LINES: '30' }, 'echo "$UDID"')).toBe(`UDID='${UDID}'; LINES='30'; echo "$UDID"`);
  });
  it('quotes a value with a single quote so it cannot break out', () => {
    expect(withVars({ X: "a'b" }, 'true')).toBe(`X='a'\\''b'; true`);
  });
});

describe('scripts only read their parameters from variables', () => {
  it('simctl scripts', () => {
    expect(SIMCTL_LIST_SCRIPT).toBe('xcrun simctl list devices -j');
    expect(SIMCTL_BOOT_SCRIPT).toContain('xcrun simctl boot "$UDID"');
  });
  it('runner scripts use $SESSION/$UDID/$WDA_PORT/$MJPEG_PORT/$LINES and the WDA checkout', () => {
    expect(WDA_RUNNER_START_SCRIPT).toContain('tmux new-session -d -s "$SESSION"');
    expect(WDA_RUNNER_START_SCRIPT).toContain('-destination id=$UDID');
    expect(WDA_RUNNER_START_SCRIPT).toContain('USE_PORT=$WDA_PORT MJPEG_SERVER_PORT=$MJPEG_PORT');
    expect(WDA_RUNNER_START_SCRIPT).toContain(WDA_DIR);
    expect(WDA_RUNNER_ALIVE_SCRIPT).toContain(`tmux has-session -t "=$SESSION"`);
    expect(WDA_RUNNER_TAIL_SCRIPT).toContain(`tmux capture-pane -p -t "=$SESSION"`);
    expect(WDA_RUNNER_TAIL_SCRIPT).toContain('tail -n "$LINES"');
  });
  it('setup scripts: file content, start (idempotent) and state', () => {
    expect(WDA_SETUP_SH).toContain('git clone --depth 1 https://github.com/appium/WebDriverAgent');
    expect(WDA_SETUP_SH).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(WDA_SETUP_SH).toContain('wda-setup.status');
    expect(WDA_SETUP_START_SCRIPT).toContain(`tmux has-session -t '=${WDA_SETUP_SESSION}'`);
    expect(WDA_SETUP_START_SCRIPT).toContain('echo STARTED:no');
    expect(WDA_SETUP_START_SCRIPT).toContain('echo STARTED:yes');
    expect(WDA_SETUP_START_SCRIPT).toContain(WDA_SETUP_SH);
    expect(WDA_SETUP_STATE_SCRIPT).toContain('echo STATE:running');
    expect(WDA_SETUP_STATE_SCRIPT).toContain('echo VERSION:');
    expect(WDA_SETUP_STATE_SCRIPT).toContain('echo TAIL:');
  });
});
