import { expect, it } from 'vitest';
import { resolveConfigDir } from './index.js';

// TER-613: the chat spawns the CLI without a shell, so nothing expands `~` or `$HOME` in
// CLAUDE_CONFIG_DIR; the CLI then reads it as a path relative to its cwd and makes a literal `~`.
it('expands the home forms a config dir is stored in, as the shell would for a tab', () => {
  expect(resolveConfigDir('~/.claude_pedro', '/home/u')).toBe('/home/u/.claude_pedro');
  expect(resolveConfigDir('~', '/home/u')).toBe('/home/u');
  expect(resolveConfigDir('$HOME/.claude_pedro', '/home/u')).toBe('/home/u/.claude_pedro');
  expect(resolveConfigDir('${HOME}/.claude_pedro', '/home/u')).toBe('/home/u/.claude_pedro');
  expect(resolveConfigDir('$HOME', '/home/u')).toBe('/home/u');
  expect(resolveConfigDir('  ~/.claude_pedro  ', '/home/u')).toBe('/home/u/.claude_pedro');
});

it('leaves an absolute dir, and a `~user` it cannot resolve, unchanged', () => {
  expect(resolveConfigDir('/opt/claude/cfg', '/home/u')).toBe('/opt/claude/cfg');
  expect(resolveConfigDir('~other/.claude', '/home/u')).toBe('~other/.claude');
  expect(resolveConfigDir('$HOMEX/.claude', '/home/u')).toBe('$HOMEX/.claude');
});

it('does not double the slash when HOME ends in one', () => {
  expect(resolveConfigDir('~/.claude', '/')).toBe('/.claude');
  expect(resolveConfigDir('~/.claude', '/home/u/')).toBe('/home/u/.claude');
});
