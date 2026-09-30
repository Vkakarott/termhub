import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeScreenState } from './screen-state.js';

/** Real captures of Claude Code 2.1.285 (TER-615), trailing blanks trimmed, paths replaced. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/claude-screens/${name}-2.1.285.txt`, import.meta.url), 'utf8');

describe('claudeScreenState — what a Claude Code tab shows (TER-615)', () => {
  it('a turn in progress: the spinner with its ellipsis, even with the input box drawn under it', () => {
    expect(claudeScreenState(fixture('working'))).toBe('busy');
  });

  it('a finished turn: the input box and no live spinner ("✻ Sautéed for 39s" is past tense)', () => {
    expect(claudeScreenState(fixture('idle'))).toBe('prompt');
  });

  it('a main thread that ended its turn while a subagent runs in the background is at its prompt', () => {
    expect(claudeScreenState(fixture('background-agent'))).toBe('prompt');
  });

  it('an AskUserQuestion dialog', () => {
    expect(claudeScreenState(fixture('question'))).toBe('dialog');
  });

  it('a permission dialog', () => {
    const screen = ['● Bash(rm -rf build)', '', '────────────────', ' Bash command', '', '   rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'].join('\n');
    expect(claudeScreenState(screen)).toBe('dialog');
  });

  it('accepts other spinner glyphs, the ASCII ellipsis and a verb with accents', () => {
    for (const line of ['✽ Sautéing… (3s)', '* Thinking... (esc to interrupt)', '· Moonwalking…', '✶ Clauding… (2m 3s · ↓ 1.2k tokens)']) {
      expect(claudeScreenState(`● Olá\n\n${line}\n\n────────────\n❯ \n────────────`)).toBe('busy');
    }
  });

  it('reads nothing into an answer that merely contains an ellipsis or a star', () => {
    const answer = ['● Vou pensar…', '  * item one...', '', '✻ Brewed for 3s', '', '────────────', '❯ ', '────────────'].join('\n');
    expect(claudeScreenState(answer)).toBe('prompt');
  });

  it('is unknown for a screen that is not Claude Code (a shell after it exited, an empty pane)', () => {
    expect(claudeScreenState('pedro@jarvis:~/termhub$ ')).toBeNull();
    expect(claudeScreenState('')).toBeNull();
  });

  it('never takes a typed "❯" inside the transcript for the input box', () => {
    expect(claudeScreenState('❯ Run the tests\n\n● Done.')).toBeNull();
  });
});
