import type { Repositories } from '../db/repositories/index.js';
import { boardGrantable } from './gate.js';

const idOf = (v: unknown) => (typeof v === 'string' && v.length >= 1 && v.length <= 64 ? v : null);

/**
 * The project a board call writes into, read owner-scoped — or null when it does not resolve (unknown
 * id, another user's card or project), which the grant always reads as "ask". Shared by the gate and
 * the decision routes, so "Permitir sempre neste projeto" is accepted for exactly the calls the gate
 * will honour.
 */
export async function boardProjectOf(repos: Repositories, ownerId: string, tool: string, args: Record<string, unknown>): Promise<string | null> {
  if (!boardGrantable(tool)) return null;
  if (tool === 'create_task') {
    const projectId = idOf(args.project_id);
    if (!projectId) return null;
    const [project] = await repos.projects.findByIdsForOwner([projectId], ownerId);
    return project?.id ?? null;
  }
  const taskId = idOf(args.task_id);
  if (!taskId) return null;
  const [task] = await repos.tasks.findByIdsForOwner([taskId], ownerId);
  return task?.project_id ?? null;
}
