import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { permissionDialogVisible, promptVisible } from './permission-dialog.js';

const fx = (name: string) => readFileSync(new URL(`./fixtures/permission-dialogs/${name}`, import.meta.url), 'utf8');
const real = readFileSync(new URL('./fixtures/tab-questions/screen-permission.txt', import.meta.url), 'utf8');

describe('permissionDialogVisible', () => {
  it('still sees the real Claude Code Bash capture', () => expect(permissionDialogVisible(real)).toBe(true));
  it.each([
    'claude-edit.txt', 'claude-webfetch.txt', 'claude-network.txt', 'claude-exit-plan.txt', 'claude-enter-plan.txt', 'claude-skill.txt',
    'claude-reads-outside.txt', 'claude-trust.txt', 'codex-command.txt', 'codex-edits.txt', 'codex-permissions.txt', 'codex-network.txt',
  ])('sees %s', (f) => expect(permissionDialogVisible(fx(f))).toBe(true));
  it.each(['claude-prompt.txt', 'claude-exit-menu.txt', 'claude-prose-question.txt', 'claude-cursor-above-marker.txt'])('ignores %s', (f) =>
    expect(permissionDialogVisible(fx(f))).toBe(false));
  it('ignores a dialog that scrolled away', () => {
    const filler = Array.from({ length: 30 }, (_, i) => `● line ${i}`).join('\n');
    expect(permissionDialogVisible(`${fx('claude-exit-plan.txt')}\n${filler}\n${fx('claude-prompt.txt')}`)).toBe(false);
  });
});

describe('promptVisible stays strict', () => {
  it('does not accept a permission dialog without the Esc footer', () =>
    expect(promptVisible(fx('claude-exit-plan.txt'), { kind: 'permission', payload: { tool_name: 'ExitPlanMode' } })).toBe(false));
});
