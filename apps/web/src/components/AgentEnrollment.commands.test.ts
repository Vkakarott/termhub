// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LINUX_INSTALL_COMMAND, MACOS_INSTALL_COMMAND } from './AgentEnrollment';

/**
 * Runs the copy-paste install commands for real, in sh and bash, with every external command
 * replaced by a stub on an isolated PATH. Each stub appends its argv to a log and exits with the
 * code the test gives it, so the tests prove which steps ran — above all that npm never runs
 * after a failed package-manager step.
 */
const SHELLS = ['/bin/sh', '/bin/bash'].filter((s) => fs.existsSync(s));
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function run(shell: string, command: string, stubs: Record<string, number | string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-install-'));
  dirs.push(dir);
  const log = path.join(dir, 'calls.log');
  for (const [name, behavior] of Object.entries(stubs)) {
    const body = typeof behavior === 'number' ? `exit ${behavior}` : behavior;
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  }
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(shell, ['-c', command], { env: { PATH: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { status: number; stdout: string };
    status = e.status;
    stdout = e.stdout;
  }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status, stdout, calls };
}

describe.each(SHELLS)('LINUX_INSTALL_COMMAND in %s', (shell) => {
  const agent = { npm: 0, 'termhub-agent': 0 };

  it('as root on apt: installs the build tools and tmux without sudo, then the agent', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { id: 'echo 0', 'apt-get': 0, ...agent });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      'id -u',
      'apt-get update',
      'apt-get install -y build-essential python3 tmux',
      'npm i -g @termhub/agent',
      'termhub-agent --version',
    ]);
  });

  it('as a regular user on apt: uses sudo', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { id: 'echo 1000', 'apt-get': 0, sudo: '"$@"', ...agent });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('sudo apt-get install -y build-essential python3 tmux');
    expect(r.calls).toContain('npm i -g @termhub/agent');
  });

  it('stops before npm when apt fails, and does not fall through to another manager', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { id: 'echo 0', 'apt-get': 'case "$1" in update) exit 0;; *) exit 100;; esac', dnf: 0, pacman: 0, ...agent });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith('npm') || c.startsWith('dnf') || c.startsWith('pacman'))).toBe(false);
  });

  it('uses dnf and pacman with their own package names', () => {
    const dnf = run(shell, LINUX_INSTALL_COMMAND, { id: 'echo 0', dnf: 0, ...agent });
    expect(dnf.calls).toEqual(['id -u', 'dnf group install -y Development Tools', 'dnf install -y python3 tmux', 'npm i -g @termhub/agent', 'termhub-agent --version']);
    const pacman = run(shell, LINUX_INSTALL_COMMAND, { id: 'echo 0', pacman: 0, ...agent });
    expect(pacman.calls).toEqual(['id -u', 'pacman -S --noconfirm --needed base-devel python tmux', 'npm i -g @termhub/agent', 'termhub-agent --version']);
  });

  it('without a known package manager: explains and never runs npm', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { id: 'echo 0', ...agent });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('Instale tmux, make, g++ e python3');
    expect(r.calls).toEqual(['id -u']);
  });

  it('does not print the version when npm fails', () => {
    const r = run(shell, LINUX_INSTALL_COMMAND, { id: 'echo 0', 'apt-get': 0, npm: 1, 'termhub-agent': 0 });
    expect(r.status).not.toBe(0);
    expect(r.calls).not.toContain('termhub-agent --version');
  });
});

describe.each(SHELLS)('MACOS_INSTALL_COMMAND in %s', (shell) => {
  const agent = { npm: 0, 'termhub-agent': 0 };

  it('installs tmux with brew when it is missing, then the agent', () => {
    const r = run(shell, MACOS_INSTALL_COMMAND, { 'xcode-select': 0, brew: 0, ...agent });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['xcode-select -p', 'brew install tmux', 'npm i -g @termhub/agent', 'termhub-agent --version']);
  });

  it('skips brew when tmux is already there', () => {
    const r = run(shell, MACOS_INSTALL_COMMAND, { 'xcode-select': 0, tmux: 0, brew: 0, ...agent });
    expect(r.calls).not.toContain('brew install tmux');
    expect(r.calls).toContain('npm i -g @termhub/agent');
  });

  it('stops before npm when brew fails', () => {
    const r = run(shell, MACOS_INSTALL_COMMAND, { 'xcode-select': 0, brew: 1, ...agent });
    expect(r.status).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith('npm'))).toBe(false);
  });

  it('opens the Command Line Tools installer and stops when the compiler is missing', () => {
    const r = run(shell, MACOS_INSTALL_COMMAND, { 'xcode-select': 'case "$1" in -p) exit 2;; *) exit 0;; esac', brew: 0, ...agent });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('Conclua a instalação das Command Line Tools');
    expect(r.calls).toEqual(['xcode-select -p', 'xcode-select --install']);
  });
});

describe('apps/agent/README.md', () => {
  it('shows the same install commands as the Add machine screen', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../../../agent/README.md'), 'utf8');
    expect(readme).toContain(LINUX_INSTALL_COMMAND);
    expect(readme).toContain(MACOS_INSTALL_COMMAND);
  });
});
