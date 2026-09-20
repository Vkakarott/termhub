import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { npmCliBesideNode } from './update.js';

describe('npmCliBesideNode (npm shipped beside the running node)', () => {
  let dir: string;
  let execPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-npm-cli-'));
    execPath = path.join(dir, 'bin', 'node');
    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    fs.writeFileSync(execPath, '// fake node binary\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the npm symlink beside node to its real npm-cli.js target', () => {
    const cliTarget = path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(cliTarget), { recursive: true });
    fs.writeFileSync(cliTarget, '// fake npm-cli.js\n', 'utf8');
    fs.symlinkSync(cliTarget, path.join(dir, 'bin', 'npm'));

    expect(npmCliBesideNode(execPath)).toBe(fs.realpathSync(cliTarget));
  });

  it('falls back to the conventional ../lib/node_modules/npm/bin/npm-cli.js path when there is no npm symlink', () => {
    const cliTarget = path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(cliTarget), { recursive: true });
    fs.writeFileSync(cliTarget, '// fake npm-cli.js\n', 'utf8');

    expect(npmCliBesideNode(execPath)).toBe(cliTarget);
  });

  it('returns null when neither the symlink nor the fallback path exists', () => {
    expect(npmCliBesideNode(execPath)).toBeNull();
  });
});
