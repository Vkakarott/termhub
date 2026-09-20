import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_SEPARATOR, credentialScript } from './ai-credentials.js';

const sha256_8 = (dir: string) => createHash('sha256').update(dir).digest('hex').slice(0, 8);

describe('credentialScript(claude)', () => {
  it('prints the on-disk file candidate first', () => {
    expect(credentialScript('claude')).toContain('$D/.credentials.json');
  });

  it('looks up the per-config-dir keychain item with shasum -a 256', () => {
    const script = credentialScript('claude');
    expect(script).toContain('shasum -a 256');
    expect(script).toContain('Claude Code-credentials-$H');
  });

  it('only tries the unsuffixed keychain item for the default $HOME/.claude dir', () => {
    expect(credentialScript('claude')).toContain('"$D" = "$HOME/.claude"');
  });

  it('separates every candidate with CREDENTIAL_SEPARATOR', () => {
    const script = credentialScript('claude');
    expect(script).toContain(CREDENTIAL_SEPARATOR);
    // one separator after the file candidate, one after each of the two Darwin keychain candidates
    expect(script.split('"$SEP"').length - 1).toBe(3);
  });

  it('only runs the keychain candidates on Darwin', () => {
    expect(credentialScript('claude')).toContain('Darwin');
  });

  it.skipIf(!existsSync('/bin/sh'))('actually running it on a non-Darwin machine prints the file content plus one separator', () => {
    const root = mkdtempSync(join(tmpdir(), 'termhub-ai-cred-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir);
      // fake `uname` so the script takes the non-Darwin path regardless of the host OS
      writeFileSync(join(binDir, 'uname'), '#!/bin/sh\necho Linux\n');
      chmodSync(join(binDir, 'uname'), 0o755);

      const configDir = join(root, '.claude');
      mkdirSync(configDir);
      const fileContent = '{"claudeAiOauth":{"accessToken":"fake-token"}}';
      writeFileSync(join(configDir, '.credentials.json'), fileContent);

      const script = `D="${configDir}"; ${credentialScript('claude')}`;
      const stdout = execFileSync('/bin/sh', ['-c', script], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: root },
        encoding: 'utf8',
      });

      expect(stdout).toBe(`${fileContent}\n${CREDENTIAL_SEPARATOR}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync('/bin/sh'))(
    'actually running it on a Darwin machine looks up the per-dir keychain item always, and the unsuffixed one only for the default dir',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'termhub-ai-cred-darwin-'));
      try {
        const binDir = join(root, 'bin');
        mkdirSync(binDir);
        // fake `uname` so the script takes the Darwin path regardless of the host OS
        writeFileSync(join(binDir, 'uname'), '#!/bin/sh\necho Darwin\n');
        chmodSync(join(binDir, 'uname'), 0o755);
        // fake `security`: echoes the value passed to -s (the keychain service name being queried), one line
        writeFileSync(
          join(binDir, 'security'),
          ['#!/bin/sh', 'prev=""', 'for arg in "$@"; do', '  if [ "$prev" = "-s" ]; then echo "$arg"; fi', '  prev="$arg"', 'done', ''].join('\n'),
        );
        chmodSync(join(binDir, 'security'), 0o755);

        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: root };
        const run = (configDir: string) => execFileSync('/bin/sh', ['-c', `D="${configDir}"; ${credentialScript('claude')}`], { env, encoding: 'utf8' });

        // (a) a non-default dir: only the suffixed (per-dir) item is looked up, never the bare one
        const nonDefaultDir = join(root, '.claude-work');
        const nonDefaultOut = run(nonDefaultDir);
        expect(nonDefaultOut).toContain(`Claude Code-credentials-${sha256_8(nonDefaultDir)}`);
        expect(nonDefaultOut.split('\n')).not.toContain('Claude Code-credentials');
        expect(nonDefaultOut.split(CREDENTIAL_SEPARATOR).length - 1).toBe(3);

        // (b) the default dir: both the suffixed and the unsuffixed items are looked up
        const defaultDir = join(root, '.claude');
        const defaultOut = run(defaultDir);
        expect(defaultOut).toContain(`Claude Code-credentials-${sha256_8(defaultDir)}`);
        expect(defaultOut.split('\n')).toContain('Claude Code-credentials');
        expect(defaultOut.split(CREDENTIAL_SEPARATOR).length - 1).toBe(3);

        // a trailing slash on $D must not change the hash
        const trailingSlashOut = run(`${nonDefaultDir}/`);
        expect(trailingSlashOut).toContain(`Claude Code-credentials-${sha256_8(nonDefaultDir)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('credentialScript(other providers)', () => {
  it('does not add the separator for chatgpt, gemini or antigravity', () => {
    for (const provider of ['chatgpt', 'gemini', 'antigravity'] as const) {
      expect(credentialScript(provider)).not.toContain(CREDENTIAL_SEPARATOR);
    }
  });
});
