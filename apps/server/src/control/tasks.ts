import { config } from '../config.js';
import { TaskRuleError } from '../db/repositories/tasks.js';
import type { Task, TaskStatus, TaskWithSubtasks } from '../db/repositories/types.js';
import { ControlError, type ControlContext } from './context.js';

/** Field limits, the same the REST routes enforce (`routes/tasks.ts`). */
export const TASK_TITLE_MAX = 300;
export const TASK_DESCRIPTION_MAX = 5000;
export const TASK_POSITION_MAX = 10_000;

export interface SubtaskIn {
  title: string;
  description?: string | null;
}

/** A task as the tools return it: never `external_ref` (provider payload the model does not need). */
export interface TaskOut {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  position: number;
  parent_id: string | null;
  tab_id: string | null;
  external_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskTreeOut extends TaskOut {
  subtasks: TaskOut[];
  subtask_counts: { done: number; total: number };
}

const out = (t: Task): TaskOut => ({
  id: t.id, title: t.title, description: t.description, status: t.status, position: t.position, parent_id: t.parent_id,
  tab_id: t.tab_id, external_key: t.external_key, created_at: t.created_at, updated_at: t.updated_at,
});
const outTree = (t: TaskWithSubtasks): TaskTreeOut => ({ ...out(t), subtasks: t.subtasks.map(out), subtask_counts: t.subtask_counts });

/** Where the person sees this board in the app. */
export function boardUrl(projectId: string): string {
  return `${config.publicUrl}/projects/${projectId}/tasks`;
}

/** Subtask rules live in the repository (spec §5.1); a broken one is the caller's mistake, said in pt-BR. */
async function rules<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TaskRuleError) throw new ControlError(e.code, e.message);
    throw e;
  }
}

export async function listTasks(ctx: ControlContext, input: { project_id: string; status?: TaskStatus }): Promise<{ project_id: string; board_url: string; tasks: TaskTreeOut[] }> {
  await ctx.scoped.project(input.project_id);
  const tasks = await ctx.repos.tasks.listByProject(input.project_id);
  return {
    project_id: input.project_id,
    board_url: boardUrl(input.project_id),
    tasks: tasks.filter((t) => !input.status || t.status === input.status).map(outTree),
  };
}

export async function createTask(
  ctx: ControlContext,
  input: { project_id: string; title: string; description?: string | null; status?: TaskStatus; subtasks?: SubtaskIn[] },
): Promise<{ task: TaskTreeOut; board_url: string }> {
  await ctx.scoped.project(input.project_id);
  const task = await rules(() => ctx.repos.tasks.createWithSubtasks(input.project_id, { title: input.title, description: input.description, status: input.status }, input.subtasks ?? []));
  return { task: outTree(task), board_url: boardUrl(input.project_id) };
}

export async function addSubtasks(ctx: ControlContext, input: { task_id: string; subtasks: SubtaskIn[] }): Promise<{ task_id: string; subtasks: TaskOut[]; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  const created = await rules(() => ctx.repos.tasks.createSubtasks(task.id, input.subtasks, task.project_id));
  return { task_id: task.id, subtasks: created.map(out), board_url: boardUrl(task.project_id) };
}

export async function updateTask(
  ctx: ControlContext,
  input: { task_id: string; title?: string; description?: string | null; status?: TaskStatus },
): Promise<{ task: TaskOut; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  if (input.title === undefined && input.description === undefined && input.status === undefined) {
    throw new ControlError('BAD_REQUEST', 'Informe title, description ou status');
  }
  const updated = await rules(() => ctx.repos.tasks.update(task.id, { title: input.title, description: input.description, status: input.status }));
  if (!updated) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { task: out(updated), board_url: boardUrl(task.project_id) };
}

/** Top-level tasks only: the repository refuses a subtask (they have no column of their own). */
export async function moveTask(ctx: ControlContext, input: { task_id: string; status: TaskStatus; position?: number }): Promise<{ task: TaskOut; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  const moved = await rules(() => ctx.repos.tasks.move(task.id, input.status, input.position ?? 0));
  if (!moved) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { task: out(moved), board_url: boardUrl(task.project_id) };
}

const subtaskCount = (n: number) => (n === 1 ? '1 subtarefa' : `${n} subtarefas`);

/** Destructive and cascading, so it needs `confirm: true`; the refusal spells out what would go. */
export async function deleteTask(ctx: ControlContext, input: { task_id: string; confirm?: boolean }): Promise<{ deleted: true; task_id: string; deleted_subtasks: number; board_url: string }> {
  const { task } = await ctx.scoped.task(input.task_id);
  const children = await ctx.repos.tasks.childIds(task.id);
  if (!input.confirm) {
    const what = children.length ? `a tarefa "${task.title}" e ${subtaskCount(children.length)}` : `a tarefa "${task.title}"`;
    throw new ControlError('CONFIRM_REQUIRED', `Isso exclui ${what}; repita com confirm: true para confirmar`);
  }
  // Tickets point at tasks by id with no FK: unlink the whole subtree so they show as "não importado" again.
  for (const id of [task.id, ...children]) await ctx.repos.tickets.unlinkTask(id);
  if (!(await ctx.repos.tasks.delete(task.id))) throw new ControlError('NOT_FOUND', 'Tarefa não encontrada');
  return { deleted: true, task_id: task.id, deleted_subtasks: children.length, board_url: boardUrl(task.project_id) };
}
