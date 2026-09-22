import { describe, expect, it } from 'vitest';
import { activityOf } from './activity.js';

describe('activityOf', () => {
  it.each([
    ['Edit', 'coding'], ['Write', 'coding'], ['MultiEdit', 'coding'], ['NotebookEdit', 'coding'],
    ['Read', 'reading'], ['Grep', 'reading'], ['Glob', 'reading'], ['LS', 'reading'],
    ['WebSearch', 'researching'], ['WebFetch', 'researching'],
    ['EnterPlanMode', 'planning'], ['ExitPlanMode', 'planning'], ['AskUserQuestion', 'planning'], ['TodoWrite', 'planning'], ['TaskCreate', 'planning'], ['TaskUpdate', 'planning'],
    ['Bash', 'terminal'],
  ])('%s → %s', (tool, activity) => {
    expect(activityOf(tool)).toBe(activity);
  });

  it('is exact: case, prefixes and MCP tools fall back to working', () => {
    expect(activityOf('edit')).toBe('working');
    expect(activityOf('Editor')).toBe('working');
    expect(activityOf('mcp__termhub__read_screen')).toBe('working');
    expect(activityOf('Agent')).toBe('working');
    expect(activityOf('Skill')).toBe('working');
  });

  it('reads working for anything that is not a string', () => {
    for (const v of [null, undefined, 42, {}, [], '']) expect(activityOf(v)).toBe('working');
  });
});
