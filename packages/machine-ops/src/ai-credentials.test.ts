import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_SEPARATOR, credentialScript } from './ai-credentials.js';

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
  });
});

describe('credentialScript(other providers)', () => {
  it('does not add the separator for chatgpt, gemini or antigravity', () => {
    for (const provider of ['chatgpt', 'gemini', 'antigravity'] as const) {
      expect(credentialScript(provider)).not.toContain(CREDENTIAL_SEPARATOR);
    }
  });
});
