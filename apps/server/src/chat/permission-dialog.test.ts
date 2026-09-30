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
    'codex-long-command.txt', 'claude-cursor-last-option.txt', 'claude-option-description.txt',
    'codex-echo-above-dialog.txt', 'claude-option-description-narrow.txt', 'claude-cursor-last-option-narrow.txt',
    'codex-quote-above-options.txt', 'codex-dashes-above-options.txt', 'codex-box-rule-above-options.txt',
  ])('sees %s', (f) => expect(permissionDialogVisible(fx(f))).toBe(true));
  it.each([
    'claude-prompt.txt', 'claude-exit-menu.txt', 'claude-prose-question.txt', 'claude-cursor-above-marker.txt', 'claude-resume-list.txt',
    'claude-typed-numbered-prompt.txt', 'claude-typed-numbered-list.txt', 'claude-quoted-list.txt', 'codex-typed-numbered-prompt.txt',
  ])('ignores %s', (f) => expect(permissionDialogVisible(fx(f))).toBe(false));
  it('ignores a dialog that scrolled away', () => {
    const filler = Array.from({ length: 30 }, (_, i) => `● line ${i}`).join('\n');
    expect(permissionDialogVisible(`${fx('claude-exit-plan.txt')}\n${filler}\n${fx('claude-prompt.txt')}`)).toBe(false);
  });
  it('sees a long command whose question scrolled out of the window, by the options below the cursor (TER-374)', () =>
    expect(permissionDialogVisible(fx('codex-long-command.txt'))).toBe(true));
  it('sees the same dialog over CRLF line endings', () => expect(permissionDialogVisible(fx('claude-exit-plan.txt').replace(/\n/g, '\r\n'))).toBe(true));
  it('sees a footer-less dialog whose question wraps over two lines', () =>
    expect(
      permissionDialogVisible(
        [
          '────────────────────────────────────────────────────────────────────────────────',
          ' Allow reads outside the working directories? This grants access beyond the project',
          ' root for the rest of the session.',
          ' ❯ 1. Yes, keep allowing reads outside the working directories',
          '   2. No, block reads outside the working directories from now on',
          '   3. No, ask again next time',
        ].join('\n'),
      ),
    ).toBe(true));
  it('sees a menu whose middle option wraps over 10 continuation rows in a very narrow pane (TER-380 fix round 2)', () =>
    expect(
      permissionDialogVisible(
        [
          '────────────────────────────────────────',
          ' Bash command',
          '   rm -rf dist',
          ' Do you want to proceed?',
          '   1. Yes',
          "   2. Yes, and don't ask again for rm",
          '      commands in',
          '      /home/dev/project/some/very/long',
          '      /path/that/keeps/wrapping/in/a',
          '      narrow/pane/that/keeps/going',
          '      and/going/and/going/some/more',
          '      even/further/down/the/tree',
          '      still/not/done/wrapping/here',
          '      almost/at/the/end/of/the/path',
          '      just/one/more/segment/to/go',
          '      finally/the/last/continuation',
          ' ❯ 3. No, and tell Claude what to do',
          '      differently (esc)',
        ].join('\n'),
      ),
    ).toBe(true));
});

describe('promptVisible stays strict', () => {
  it('does not accept a permission dialog without the Esc footer', () =>
    expect(promptVisible(fx('claude-exit-plan.txt'), { kind: 'permission', payload: { tool_name: 'ExitPlanMode' } })).toBe(false));
});

describe('promptVisible for Codex rows', () => {
  const shot = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
  const approval = shot('permission-dialogs/codex-reason.txt');
  const ask = shot('codex-questions/two-questions.txt');
  const permRow = { kind: 'permission' as const, payload: { tool_name: 'Bash', agent: 'codex' as const } };
  const opt = (label: string) => ({ label, description: '', recommended: false });
  const choiceRow = {
    kind: 'choice' as const,
    payload: { agent: 'codex' as const, questions: [{ question: 'Qual cor: azul ou verde?', header: 'Cor', multi_select: false, options: [opt('Azul'), opt('Verde')] }] },
  };
  /** The same capture with the dialog gone: everything from `from` on replaced by Codex's idle composer. */
  const idle = (screen: string, from: RegExp) => {
    const lines = screen.split('\n');
    return [...lines.slice(0, lines.findIndex((l) => from.test(l))), '', '› Ask Codex to do anything', '', '  gpt-5 default · ~/spike'].join('\n');
  };

  it('sees the approval menu and the question on their real screens', () => {
    expect(promptVisible(approval, permRow)).toBe(true);
    expect(promptVisible(ask, choiceRow)).toBe(true);
  });
  it('is false once the menu is gone and Codex is back at its composer', () => {
    expect(promptVisible(idle(approval, /Would you like to run/), permRow)).toBe(false);
    expect(promptVisible(idle(ask, /Question 1\/2/), choiceRow)).toBe(false);
    expect(promptVisible(fx('codex-typed-numbered-prompt.txt'), permRow)).toBe(false);
  });
  it('a dialog of the other kind does not satisfy the row', () => {
    expect(promptVisible(ask, permRow)).toBe(false);
    expect(promptVisible(approval, choiceRow)).toBe(false);
  });
  it('a Claude dialog never satisfies a Codex row, nor a Codex screen a Claude row', () => {
    expect(promptVisible(real, permRow)).toBe(false);
    expect(promptVisible(approval, { kind: 'permission', payload: { tool_name: 'Bash' } })).toBe(false);
  });
});
