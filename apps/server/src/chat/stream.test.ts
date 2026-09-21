import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseFrame } from './stream.js';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-basic.ndjson'), 'utf8').split('\n').filter(Boolean);
const toolCallFixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-tool-call.ndjson'), 'utf8').split('\n').filter(Boolean);

it('turns a recorded run into text deltas and a final usage', () => {
  const frames = fixture.map(parseFrame).filter((f) => f !== null);
  expect(frames.some((f) => f!.type === 'text')).toBe(true);
  expect(frames.at(-1)!.type).toBe('done');
});

it('reads a real tool call and its result', () => {
  const frames = toolCallFixture.map(parseFrame).filter((f) => f !== null);
  const call = frames.find((f) => f!.type === 'action');
  const result = frames.find((f) => f!.type === 'action_result');
  expect(call).toEqual({
    type: 'action',
    tool: 'Read',
    tool_use_id: 'toolu_01S2jgEi6qS2jvGovWPFeMoy',
    args: { file_path: '/tmp/fixture-probe.txt' },
  });
  expect(result).toEqual({ type: 'action_result', tool_use_id: 'toolu_01S2jgEi6qS2jvGovWPFeMoy', ok: true });
});

// The recording above used a built-in tool (--strict-mcp-config attaches no MCP server), so it never
// exercises the mcp__termhub__ prefix stripping. That mapping is termhub's own naming convention, not
// a guess at the CLI's frame shape, so a synthetic case for it is fine.
it('strips the mcp__termhub__ prefix from an MCP tool name', () => {
  const call = parseFrame(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__termhub__list_tabs', input: { project_id: 'p1' } }] },
  }));
  expect(call).toEqual({ type: 'action', tool: 'list_tabs', tool_use_id: 'tu_1', args: { project_id: 'p1' } });
});

// The recording's tool call succeeded, so there is no real failing tool_result to read; manufacturing
// one would not be worth it. This keeps the is_error path covered.
it('marks a tool result as failed when is_error is true', () => {
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
