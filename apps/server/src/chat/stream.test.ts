import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseFrame } from './stream.js';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-basic.ndjson'), 'utf8').split('\n').filter(Boolean);

it('turns a recorded run into text deltas and a final usage', () => {
  const frames = fixture.map(parseFrame).filter((f) => f !== null);
  expect(frames.some((f) => f!.type === 'text')).toBe(true);
  expect(frames.at(-1)!.type).toBe('done');
});

it('reads a tool call and its result', () => {
  const call = parseFrame(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__termhub__list_tabs', input: { project_id: 'p1' } }] },
  }));
  expect(call).toEqual({ type: 'action', tool: 'list_tabs', tool_use_id: 'tu_1', args: { project_id: 'p1' } });

  const result = parseFrame(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: [{ type: 'text', text: 'Este token não tem o escopo `terminals`' }] }] },
  }));
  expect(result).toEqual({ type: 'action_result', tool_use_id: 'tu_1', ok: false });
});

it('reports the runner error line the container appends', () => {
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, message: 'claude exited with 1' }))).toEqual({ type: 'error', message: 'claude exited with 1' });
});

it('ignores a malformed line instead of throwing', () => {
  expect(parseFrame('not json')).toBeNull();
  expect(parseFrame(JSON.stringify({ type: 'something_new' }))).toBeNull();
  expect(parseFrame('null')).toBeNull();
  expect(parseFrame('[1,2,3]')).toBeNull();
});
