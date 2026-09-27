import { expect, it } from 'vitest';
import { subagentOrigins, toolUseIdOf } from './subagent-origin.js';

it('remembers and expires after an hour', () => {
  subagentOrigins.clear();
  subagentOrigins.remember('toolu_1', { conversationId: 'c', subagentId: 's' }, 0);
  expect(subagentOrigins.originOf('toolu_1', 1000)).toEqual({ conversationId: 'c', subagentId: 's' });
  expect(subagentOrigins.originOf('toolu_1', 60 * 60 * 1000 + 1)).toBeUndefined();
});

it('keeps at most 5000 entries, oldest out first', () => {
  subagentOrigins.clear();
  for (let i = 0; i < 5001; i++) subagentOrigins.remember(`t${i}`, { conversationId: 'c', subagentId: 's' }, 0);
  expect(subagentOrigins.originOf('t0', 0)).toBeUndefined();
  expect(subagentOrigins.originOf('t5000', 0)).toBeDefined();
});

it('reads the tool-use id from _meta only when it is id-shaped', () => {
  expect(toolUseIdOf({ 'claudecode/toolUseId': 'toolu_01JW' })).toBe('toolu_01JW');
  expect(toolUseIdOf({ 'claudecode/toolUseId': 'a b' })).toBeUndefined();
  expect(toolUseIdOf({ 'claudecode/toolUseId': 'x'.repeat(129) })).toBeUndefined();
  expect(toolUseIdOf(undefined)).toBeUndefined();
});
