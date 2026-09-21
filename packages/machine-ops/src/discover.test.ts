import { describe, expect, it } from 'vitest';
import { claudeDirsFromHome, configDirsFromRc } from './discover.js';

describe('claudeDirsFromHome', () => {
  it('takes the dirs named like a Claude config dir that carry one of its markers', () => {
    const dirs = claudeDirsFromHome([
      { name: '.claude', files: ['settings.json', 'projects'] },
      { name: '.claude-pedro-goiania', files: ['projects'] },
      { name: '.claude_drhorton', files: ['.credentials.json'] },
    ]);
    expect(dirs).toEqual(['~/.claude', '~/.claude-pedro-goiania', '~/.claude_drhorton']);
  });

  it('leaves out a dir with the right name but no marker inside', () => {
    expect(claudeDirsFromHome([{ name: '.claude-notes', files: ['todo.md'] }])).toEqual([]);
  });

  it('leaves out a dir whose name is not a Claude config dir', () => {
    expect(claudeDirsFromHome([{ name: '.config', files: ['settings.json'] }])).toEqual([]);
  });
});

describe('configDirsFromRc', () => {
  it('takes CLAUDE_CONFIG_DIR out of the aliases people write for each account', () => {
    const rc = [
      `alias claude-pedro='CLAUDE_CONFIG_DIR="$HOME/.claude-pedro-goiania" claude'`,
      `alias claude_drhorton='CLAUDE_CONFIG_DIR=~/.claude_drhorton claude'`,
    ].join('\n');
    expect(configDirsFromRc(rc)).toEqual(['~/.claude-pedro-goiania', '~/.claude_drhorton']);
  });

  it('takes an exported absolute path and a fish `set -x`', () => {
    expect(configDirsFromRc('export CLAUDE_CONFIG_DIR=/opt/claude\n')).toEqual(['/opt/claude']);
    expect(configDirsFromRc('set -x CLAUDE_CONFIG_DIR ~/.claude-fish\n')).toEqual(['~/.claude-fish']);
  });

  it('ignores commented lines, repeats and paths that lead nowhere', () => {
    const rc = [
      '# CLAUDE_CONFIG_DIR=~/.claude-old',
      'export CLAUDE_CONFIG_DIR=~/.claude-a',
      'export CLAUDE_CONFIG_DIR="$HOME/.claude-a"',
      'export CLAUDE_CONFIG_DIR=~',
      'export CLAUDE_CONFIG_DIR=',
    ].join('\n');
    expect(configDirsFromRc(rc)).toEqual(['~/.claude-a']);
  });

  it('takes a bare name as relative to the home, the way the shell would not', () => {
    expect(configDirsFromRc('export CLAUDE_CONFIG_DIR=.claude-work\n')).toEqual(['~/.claude-work']);
  });
});
