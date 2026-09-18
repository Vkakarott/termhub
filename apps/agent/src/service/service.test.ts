import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../exec.js';

vi.mock('../exec.js', async () => {
  const actual = await vi.importActual<typeof import('../exec.js')>('../exec.js');
  return { ...actual, agentEnv: () => ({ PATH: '/usr/local/bin:/usr/bin:/bin' }) };
});

const { renderPlist, install: launchdInstall, uninstall: launchdUninstall, status: launchdStatus, LABEL } = await import('./launchd.js');
const { renderUnit, install: systemdInstall, uninstall: systemdUninstall, status: systemdStatus, UNIT_NAME } = await import('./systemd.js');
const { serviceFileOptions } = await import('./index.js');

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}
function fail(stderr = 'boom'): RunResult {
  return { code: 1, stdout: '', stderr, timedOut: false };
}

describe('renderPlist', () => {
  it('matches the expected launchd XML', () => {
    const xml = renderPlist({ label: 'dev.termhub.agent', node: '/usr/local/bin/node', script: '/opt/termhub-agent/dist/cli.js', logPath: '/home/pedro/.termhub/agent.log' });
    expect(xml).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>dev.termhub.agent</string>
        <key>ProgramArguments</key>
        <array>
          <string>/usr/local/bin/node</string>
          <string>/opt/termhub-agent/dist/cli.js</string>
          <string>run</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
          <key>SuccessfulExit</key>
          <false/>
        </dict>
        <key>StandardOutPath</key>
        <string>/home/pedro/.termhub/agent.log</string>
        <key>StandardErrorPath</key>
        <string>/home/pedro/.termhub/agent.log</string>
        <key>EnvironmentVariables</key>
        <dict>
          <key>PATH</key>
          <string>/usr/local/bin:/usr/bin:/bin</string>
        </dict>
        <key>WorkingDirectory</key>
        <string>${process.env.HOME ?? ''}</string>
      </dict>
      </plist>
      "
    `);
  });

  it('contains RunAtLoad, KeepAlive/SuccessfulExit=false and the [node, script, run] argv', () => {
    const xml = renderPlist({ label: 'dev.termhub.agent', node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' });
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<key>SuccessfulExit</key>');
    expect(xml).toContain('<false/>');
    expect(xml).toContain('<string>/n/node</string>\n    <string>/s/cli.js</string>\n    <string>run</string>');
  });

  it('XML-escapes special characters in string values', () => {
    const xml = renderPlist({ label: 'a & b', node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' });
    expect(xml).toContain('a &amp; b');
  });
});

describe('renderUnit', () => {
  it('matches the expected systemd unit', () => {
    const unit = renderUnit({ node: '/usr/local/bin/node', script: '/opt/termhub-agent/dist/cli.js', logPath: '/home/pedro/.termhub/agent.log' });
    expect(unit).toMatchInlineSnapshot(`
      "[Unit]
      Description=termhub agent
      After=network-online.target

      [Service]
      ExecStart=/usr/local/bin/node /opt/termhub-agent/dist/cli.js run
      Restart=on-failure
      RestartSec=2
      RestartPreventExitStatus=78
      Environment=PATH=/usr/local/bin:/usr/bin:/bin
      StandardOutput=append:/home/pedro/.termhub/agent.log
      StandardError=append:/home/pedro/.termhub/agent.log

      [Install]
      WantedBy=default.target
      "
    `);
  });

  it('contains RestartPreventExitStatus=78 and the ExecStart run argv', () => {
    const unit = renderUnit({ node: '/n/node', script: '/s/cli.js' });
    expect(unit).toContain('RestartPreventExitStatus=78');
    expect(unit).toContain('ExecStart=/n/node /s/cli.js run');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=2');
  });

  it('omits StandardOutput/StandardError when logPath is not given', () => {
    const unit = renderUnit({ node: '/n/node', script: '/s/cli.js' });
    expect(unit).not.toContain('StandardOutput');
    expect(unit).not.toContain('StandardError');
  });
});

describe('launchd install/uninstall/status', () => {
  it('install() writes the plist then runs bootout (ignoring failure) and bootstrap', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args[0] === 'bootout') return fail('nothing loaded');
      return ok();
    });
    await launchdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' }, { run: run as never });

    expect(calls[0][0]).toBe('launchctl');
    expect(calls[0][1]).toBe('bootout');
    expect(calls[1][0]).toBe('launchctl');
    expect(calls[1][1]).toBe('bootstrap');
    expect(calls[1]).toEqual(expect.arrayContaining([expect.stringContaining(LABEL)]));
  });

  it('install() throws when bootstrap itself fails', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => (args[0] === 'bootstrap' ? fail('denied') : ok()));
    await expect(launchdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' }, { run: run as never })).rejects.toThrow(/bootstrap failed/);
  });

  it('uninstall() runs bootout and removes the plist without throwing when the file is already gone', async () => {
    const run = vi.fn(async () => ok());
    await expect(launchdUninstall({ run: run as never })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['bootout']));
  });

  it('status() reflects the launchctl print exit code', async () => {
    const runOk = vi.fn(async () => ok());
    await expect(launchdStatus({ run: runOk as never })).resolves.toBe(true);
    const runFail = vi.fn(async () => fail());
    await expect(launchdStatus({ run: runFail as never })).resolves.toBe(false);
  });
});

describe('systemd install/uninstall/status', () => {
  it('install() writes the unit, daemon-reloads, then enables --now', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return ok();
    });
    await systemdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' }, { run: run as never });

    expect(calls[0]).toEqual(['systemctl', '--user', 'daemon-reload']);
    expect(calls[1]).toEqual(['systemctl', '--user', 'enable', '--now', UNIT_NAME]);
  });

  it('install() throws when enable --now fails', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => (args.includes('enable') ? fail('denied') : ok()));
    await expect(systemdInstall({ node: '/n/node', script: '/s/cli.js', logPath: '/l/agent.log' }, { run: run as never })).rejects.toThrow(/enable --now failed/);
  });

  it('uninstall() disables --now and removes the unit file', async () => {
    const run = vi.fn(async () => ok());
    await expect(systemdUninstall({ run: run as never })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  });

  it('status() reflects `systemctl --user is-active`', async () => {
    const runOk = vi.fn(async () => ok('active'));
    await expect(systemdStatus({ run: runOk as never })).resolves.toBe(true);
    const runFail = vi.fn(async () => fail('inactive'));
    await expect(systemdStatus({ run: runFail as never })).resolves.toBe(false);
  });
});

describe('serviceFileOptions()', () => {
  let dir: string;
  let realTarget: string;
  let symlink: string;
  const originalArgv1 = process.argv[1];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-service-paths-'));
    realTarget = path.join(dir, 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(realTarget), { recursive: true });
    fs.writeFileSync(realTarget, '// fake dist/cli.js\n', 'utf8');
    // Mirrors `npm i -g`: the global bin dir gets a symlink pointing at dist/cli.js, so
    // process.argv[1] is the symlink, not the real file, when the installed CLI runs.
    symlink = path.join(dir, 'bin', 'termhub-agent');
    fs.mkdirSync(path.dirname(symlink), { recursive: true });
    fs.symlinkSync(realTarget, symlink);
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves script through the npm-global-bin symlink to the real dist/cli.js path — a plist/unit built from argv[1] as-is would point at a symlink that breaks on reinstall', () => {
    process.argv[1] = symlink;
    const opts = serviceFileOptions();
    expect(opts.script).toBe(fs.realpathSync(realTarget));
    expect(opts.script).not.toBe(symlink);

    // And renderPlist/renderUnit faithfully carry that resolved path into the service file.
    expect(renderPlist({ label: LABEL, node: '/n/node', script: opts.script, logPath: '/l/agent.log' })).toContain(`<string>${opts.script}</string>`);
    expect(renderUnit({ node: '/n/node', script: opts.script })).toContain(`ExecStart=/n/node ${opts.script} run`);
  });
});
