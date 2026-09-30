import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dialogTool, permissionDialogVisible, promptVisible } from './permission-dialog.js';

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

const rule = '────────────────────────────────────────────────────────────────────────────────';
const fullSkill = `${fx('claude-skill.txt')}\n Do you want to proceed?\n Esc to cancel`;
const transcriptTitle = `${rule}\n Edit file\n${fullSkill}`;
const croppedBash = real.slice(real.indexOf(' Bash command'));

describe('dialogTool', () => {
  it.each([
    ['main-thread Bash', real, 'Bash'],
    ['subagent Bash', fx('claude-bash-subagent.txt'), 'Bash'],
    ['Edit', fx('claude-edit.txt'), 'Edit'],
    ['WebFetch', fx('claude-webfetch.txt'), 'WebFetch'],
    ['Skill', fx('claude-skill.txt'), null],
    ['no rule', croppedBash, null],
    ['title prefix without a space', `${rule}\n Fetching the page…`, null],
    ['known transcript title above the lowest rule', transcriptTitle, null],
    ['lowest rule with no following line', `${rule}\n Edit file\n${rule}\n`, null],
    ['blank lines and case', `${rule}\n\n BASH COMMAND \n`, 'Bash'],
  ])('identifies %s only under the lowest rule', (_label, screen, expected) => {
    expect(dialogTool(screen)).toBe(expected);
  });
});

describe('promptVisible permission tool check', () => {
  it.each([
    ['Bash', 'main-thread Bash', real, true],
    ['Bash', 'subagent Bash', fx('claude-bash-subagent.txt'), true],
    ['Bash', 'Edit', fx('claude-edit.txt'), false],
    ['Bash', 'WebFetch', `${fx('claude-webfetch.txt')}\n Esc to cancel`, false],
    ['Edit', 'Edit', fx('claude-edit.txt'), true],
    ['Edit', 'Bash', real, false],
    ['Skill', 'Bash', real, false],
    ['Skill', 'original Skill without the old marker/footer', fx('claude-skill.txt'), false],
    ['Skill', 'Skill with the old marker/footer', fullSkill, true],
    ['Bash', 'unknown title', fullSkill, true],
    ['Bash', 'cropped Bash without a rule', croppedBash, true],
    ['Bash', 'known transcript title above Skill', transcriptTitle, true],
    ['Bash', 'Bash without a footer', real.slice(0, real.indexOf(' Esc to cancel')), false],
  ])('%s card on %s', (tool_name, _label, screen, expected) => {
    expect(promptVisible(screen, { kind: 'permission', payload: { tool_name } })).toBe(expected);
  });
});

it('the gate sees the subagent Bash fixture', () => {
  expect(permissionDialogVisible(fx('claude-bash-subagent.txt'))).toBe(true);
});

it('the gate keeps its footer/marker path even without menu options', () => {
  expect(permissionDialogVisible(`${rule}\n Bash command\n Do you want to proceed?\n Esc to cancel`)).toBe(true);
});
