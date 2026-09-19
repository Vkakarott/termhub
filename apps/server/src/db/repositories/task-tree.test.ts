import { describe, expect, it } from 'vitest';
import { nestTasks } from './task-tree.js';
import type { Task } from './types.js';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1',
  title: over.id,
  description: null,
  status: 'todo',
  position: 0,
  external_ref: null,
  external_key: null,
  tab_id: null,
  parent_id: null,
  created_at: '2026-09-18T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z',
  ...over,
});

describe('nestTasks', () => {
  it('returns only top-level tasks, each with its subtasks ordered by position', () => {
    const out = nestTasks([
      task({ id: 'a' }),
      task({ id: 'a2', parent_id: 'a', position: 1 }),
      task({ id: 'a1', parent_id: 'a', position: 0 }),
      task({ id: 'b', position: 1 }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
    expect(out[0].subtasks.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(out[1].subtasks).toEqual([]);
  });

  it('counts done subtasks', () => {
    const [a] = nestTasks([
      task({ id: 'a' }),
      task({ id: 'a1', parent_id: 'a', status: 'done' }),
      task({ id: 'a2', parent_id: 'a', status: 'doing', position: 1 }),
    ]);
    expect(a.subtask_counts).toEqual({ done: 1, total: 2 });
  });

  it('keeps the incoming order of top-level tasks', () => {
    const out = nestTasks([task({ id: 'z' }), task({ id: 'y' })]);
    expect(out.map((t) => t.id)).toEqual(['z', 'y']);
  });

  it('breaks position ties by creation time', () => {
    const [a] = nestTasks([
      task({ id: 'a' }),
      task({ id: 'late', parent_id: 'a', created_at: '2026-09-18T00:00:02.000Z' }),
      task({ id: 'early', parent_id: 'a', created_at: '2026-09-18T00:00:01.000Z' }),
    ]);
    expect(a.subtasks.map((t) => t.id)).toEqual(['early', 'late']);
  });
});
