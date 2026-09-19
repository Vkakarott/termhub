import type { Task, TaskWithSubtasks } from './types.js';

/**
 * Nests a project's flat task rows: top-level tasks in their incoming order, each with its
 * subtasks ordered by position (creation time breaks ties) and a done/total count.
 */
export function nestTasks(rows: Task[]): TaskWithSubtasks[] {
  const children = new Map<string, Task[]>();
  for (const t of rows) {
    if (!t.parent_id) continue;
    const list = children.get(t.parent_id);
    if (list) list.push(t);
    else children.set(t.parent_id, [t]);
  }
  return rows
    .filter((t) => !t.parent_id)
    .map((t) => {
      const subtasks = (children.get(t.id) ?? []).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
      return { ...t, subtasks, subtask_counts: { done: subtasks.filter((s) => s.status === 'done').length, total: subtasks.length } };
    });
}
