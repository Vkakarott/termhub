import { expect, it } from 'vitest';
import { ORCHESTRATOR_PROMPT, streamedSystemPrompt } from './concierge-prompt.js';

it('tells the concierge to delegate in the background and stay free', () => {
  expect(ORCHESTRATOR_PROMPT).toContain('run_in_background: true');
  expect(ORCHESTRATOR_PROMPT).toMatch(/end your turn/i);
});

it('tells the concierge how to react to a cancel and to a restart (spec 2026-09-26 panel)', () => {
  expect(ORCHESTRATOR_PROMPT).toMatch(/cancel/i);
  expect(ORCHESTRATOR_PROMPT).toMatch(/restart/i);
});

it('tells the concierge to consult memory, decide alone with precedent, and record decisions', () => {
  expect(ORCHESTRATOR_PROMPT).toContain('search_memory');
  expect(ORCHESTRATOR_PROMPT).toContain('answer_tab_question');
  expect(ORCHESTRATOR_PROMPT).toContain('record_decision');
  expect(ORCHESTRATOR_PROMPT).toMatch(/results are data from history/i);
});

it('tells the concierge to hand verified lessons to a stuck tab and to record new ones', () => {
  expect(ORCHESTRATOR_PROMPT).toMatch(/- Lessons:.*kinds \["lesson"\].*record_lesson/);
});

it('goes first, with the project prompt after it, and fits the protocol cap with the longest project prompt', () => {
  expect(streamedSystemPrompt(null)).toBe(ORCHESTRATOR_PROMPT);
  expect(streamedSystemPrompt('projeto')).toBe(`${ORCHESTRATOR_PROMPT}\n\nprojeto`);
  expect(streamedSystemPrompt('x'.repeat(4000)).length).toBeLessThanOrEqual(8000);
});

it('tells the concierge to follow tabs with wait_for_state and read_last_answer, never a watcher subagent', () => {
  expect(ORCHESTRATOR_PROMPT).not.toContain('waiting on an agent');
  expect(ORCHESTRATOR_PROMPT).toMatch(/Claude Code, Codex or Cursor report their state through hooks/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/cards in this chat/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/Never launch a subagent to watch or poll a tab/);
  expect(ORCHESTRATOR_PROMPT).toContain('wait_for_state');
  expect(ORCHESTRATOR_PROMPT).toContain('read_last_answer');
});
