import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { nestTasks } from './task-tree.js';
import { mapTask, type Task, type TaskStatus, type TaskWithSubtasks } from './types.js';

/** JSON com chaves ordenadas (JSONB do Postgres reordena as chaves). */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export type TaskRuleCode = 'PARENT_NOT_FOUND' | 'PARENT_IS_SUBTASK' | 'SUBTASK_CANNOT_MOVE' | 'NOT_A_SUBTASK' | 'TOO_MANY_SUBTASKS';

/** Enforced both here and in the route's zod schema (which uses this constant too). */
export const MAX_SUBTASKS_PER_CALL = 50;

/** A subtask rule was broken. `message` is pt-BR and safe to show to the user. */
export class TaskRuleError extends Error {
  constructor(
    readonly code: TaskRuleCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskRuleError';
  }
}

export interface TaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  /** Creates a subtask of this task. Ignored by `update` (no reparenting). */
  parent_id?: string | null;
}

export interface SubtaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
}

export class TasksRepository {
  constructor(private db: PrismaClient) {}

  /** Top-level tasks with their subtasks nested. */
  async listByProject(projectId: string): Promise<TaskWithSubtasks[]> {
    const rows = await this.db.task.findMany({ where: { projectId }, orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }] });
    return nestTasks(rows.map(mapTask));
  }

  async findById(id: string): Promise<Task | undefined> {
    const t = await this.db.task.findUnique({ where: { id } });
    return t ? mapTask(t) : undefined;
  }

  /** Batched by id, one query regardless of how many ids are asked for — used to enrich a list of
   * rows (e.g. the chat action trail) without a lookup per row. */
  async findByIds(ids: string[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    return (await this.db.task.findMany({ where: { id: { in: ids } } })).map(mapTask);
  }

  /** Top-level: created at the top of its column (position 0), pushing the others down. Subtask: appended last. */
  async create(projectId: string, input: TaskInput): Promise<Task> {
    if (input.parent_id) {
      const [subtask] = await this.createSubtasks(input.parent_id, [{ title: input.title, description: input.description, status: input.status }], projectId);
      return subtask;
    }
    const status = input.status ?? 'todo';
    return this.db.$transaction(async (tx) => {
      await tx.task.updateMany({ where: { projectId, status, parentId: null }, data: { position: { increment: 1 } } });
      const t = await tx.task.create({
        data: { id: newId(), projectId, title: input.title, description: input.description ?? null, status, position: 0 },
      });
      return mapTask(t);
    });
  }

  /**
   * A top-level task and its subtasks in one transaction (the MCP `create_task` tool): the task
   * lands at the top of its column, the subtasks in call order. All or nothing — a cap violation
   * is rejected before anything is written.
   */
  async createWithSubtasks(projectId: string, input: { title: string; description?: string | null; status?: TaskStatus }, subtasks: SubtaskInput[]): Promise<TaskWithSubtasks> {
    if (subtasks.length > MAX_SUBTASKS_PER_CALL) {
      throw new TaskRuleError('TOO_MANY_SUBTASKS', 'No máximo 50 subtarefas por vez');
    }
    const status = input.status ?? 'todo';
    return this.db.$transaction(async (tx) => {
      await tx.task.updateMany({ where: { projectId, status, parentId: null }, data: { position: { increment: 1 } } });
      const parent = await tx.task.create({
        data: { id: newId(), projectId, title: input.title, description: input.description ?? null, status, position: 0 },
      });
      const rows = [mapTask(parent)];
      // The parent is new and invisible to other writers until commit: no row lock needed here.
      for (const [position, item] of subtasks.entries()) {
        const t = await tx.task.create({
          data: { id: newId(), projectId, parentId: parent.id, title: item.title, description: item.description ?? null, status: item.status ?? 'todo', position },
        });
        rows.push(mapTask(t));
      }
      return nestTasks(rows)[0];
    });
  }

  /**
   * Appends subtasks to `parentId` in one transaction. One level only: the parent must be a
   * top-level task (of `expectProjectId`, when given). Subtasks inherit the parent's project.
   */
  async createSubtasks(parentId: string, items: SubtaskInput[], expectProjectId?: string): Promise<Task[]> {
    if (items.length > MAX_SUBTASKS_PER_CALL) {
      throw new TaskRuleError('TOO_MANY_SUBTASKS', 'No máximo 50 subtarefas por vez');
    }
    return this.db.$transaction(async (tx) => {
      // Lock the parent row so concurrent writers appending to the same parent (e.g. an MCP tool
      // and the web board) serialize instead of both reading the same max sibling position.
      await tx.$queryRaw`SELECT id FROM "tasks" WHERE id = ${parentId} FOR UPDATE`;
      const parent = await tx.task.findUnique({ where: { id: parentId } });
      if (!parent || (expectProjectId && parent.projectId !== expectProjectId)) {
        throw new TaskRuleError('PARENT_NOT_FOUND', 'Tarefa pai não encontrada neste projeto');
      }
      if (parent.parentId) throw new TaskRuleError('PARENT_IS_SUBTASK', 'Uma subtarefa não pode ter subtarefas');
      const agg = await tx.task.aggregate({ where: { parentId }, _max: { position: true } });
      let position = (agg._max.position ?? -1) + 1;
      const created: Task[] = [];
      for (const item of items) {
        const t = await tx.task.create({
          data: {
            id: newId(),
            projectId: parent.projectId,
            parentId,
            title: item.title,
            description: item.description ?? null,
            status: item.status ?? 'todo',
            position: position++,
          },
        });
        created.push(mapTask(t));
      }
      return created;
    });
  }

  /** Ids of a task's subtasks (the route unlinks their tickets before a cascading delete). */
  async childIds(id: string): Promise<string[]> {
    const rows = await this.db.task.findMany({ where: { parentId: id }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async update(id: string, patch: Partial<TaskInput>): Promise<Task | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    if (!current.parent_id && patch.status && patch.status !== current.status) {
      return this.move(id, patch.status, 0, { title: patch.title, description: patch.description });
    }
    const t = await this.db.task.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(current.parent_id && patch.status ? { status: patch.status } : {}),
      },
    });
    return mapTask(t);
  }

  /** Move para (status, position) reordenando as colunas de origem e destino. */
  async move(id: string, status: TaskStatus, position: number, extra?: { title?: string; description?: string | null }): Promise<Task | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    if (current.parent_id) throw new TaskRuleError('SUBTASK_CANNOT_MOVE', 'Subtarefas não ficam em colunas; mude o status ou reordene');
    return this.db.$transaction(async (tx) => {
      // remove da coluna de origem
      await tx.task.updateMany({
        where: { projectId: current.project_id, status: current.status, parentId: null, position: { gt: current.position } },
        data: { position: { decrement: 1 } },
      });
      const count = await tx.task.count({ where: { projectId: current.project_id, status, parentId: null, id: { not: id } } });
      const pos = Math.max(0, Math.min(position, count));
      // abre espaço na coluna de destino
      await tx.task.updateMany({
        where: { projectId: current.project_id, status, parentId: null, position: { gte: pos }, id: { not: id } },
        data: { position: { increment: 1 } },
      });
      const t = await tx.task.update({
        where: { id },
        data: {
          status,
          position: pos,
          ...(extra?.title !== undefined ? { title: extra.title } : {}),
          ...(extra?.description !== undefined ? { description: extra.description } : {}),
        },
      });
      return mapTask(t);
    });
  }

  /** Moves a subtask to `position` among its siblings (clamped), reindexing them 0..n-1. */
  async reorder(id: string, position: number): Promise<Task | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    if (!current.parent_id) throw new TaskRuleError('NOT_A_SUBTASK', 'Só subtarefas são reordenadas aqui; use mover para tarefas do quadro');
    return this.db.$transaction(async (tx) => {
      // Lock the parent row so a concurrent createSubtasks/reorder on the same parent serializes
      // instead of both reading the same sibling snapshot.
      await tx.$queryRaw`SELECT id FROM "tasks" WHERE id = ${current.parent_id} FOR UPDATE`;
      const siblings = await tx.task.findMany({ where: { parentId: current.parent_id }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, position: true } });
      const ids = siblings.map((s) => s.id).filter((s) => s !== id);
      ids.splice(Math.max(0, Math.min(Math.trunc(position), ids.length)), 0, id);
      for (const [i, siblingId] of ids.entries()) {
        if (siblings.find((s) => s.id === siblingId)?.position !== i) await tx.task.update({ where: { id: siblingId }, data: { position: i } });
      }
      const t = await tx.task.findUnique({ where: { id } });
      return t ? mapTask(t) : undefined;
    });
  }

  /** Deletes the task (its subtasks cascade) and closes the gap: in its column, or among its siblings. */
  async delete(id: string): Promise<boolean> {
    const current = await this.findById(id);
    if (!current) return false;
    await this.db.$transaction(async (tx) => {
      await tx.task.delete({ where: { id } });
      await tx.task.updateMany({
        where: current.parent_id
          ? { parentId: current.parent_id, position: { gt: current.position } }
          : { projectId: current.project_id, status: current.status, parentId: null, position: { gt: current.position } },
        data: { position: { decrement: 1 } },
      });
    });
    return true;
  }

  /** Cria a task a partir de um ticket sincronizado (vai para o fim do backlog). */
  async createFromTicket(projectId: string, ticket: { key: string; title: string; description: string | null; ref: Record<string, unknown> }): Promise<Task> {
    const agg = await this.db.task.aggregate({ where: { projectId, status: 'backlog', parentId: null }, _max: { position: true } });
    const t = await this.db.task.create({
      data: {
        id: newId(),
        projectId,
        title: ticket.title,
        description: ticket.description,
        status: 'backlog',
        position: (agg._max.position ?? -1) + 1,
        externalKey: ticket.key,
        externalRef: ticket.ref as object,
      },
    });
    return mapTask(t);
  }

  /** Atualiza só o espelho do ticket externo (estado/meta), sem mexer em título, coluna ou descrição. */
  async setExternalRef(id: string, ref: Record<string, unknown>): Promise<void> {
    await this.db.task.updateMany({ where: { id }, data: { externalRef: ref as object } });
  }

  async setTab(id: string, tabId: string | null): Promise<Task | undefined> {
    const t = await this.db.task.update({ where: { id }, data: { tabId } });
    return mapTask(t);
  }

  /** Contagem de tasks abertas (todo + doing) por projeto. */
  async openCountByProject(): Promise<Record<string, number>> {
    const rows = await this.db.task.groupBy({ by: ['projectId'], where: { status: { in: ['todo', 'doing'] }, parentId: null }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.projectId, r._count._all]));
  }

  /** `owner`: only tasks of projects on machines of that user (null = all). */
  async listDoing(owner: string | null = null): Promise<Task[]> {
    const rows = await this.db.task.findMany({
      where: { status: 'doing', parentId: null, ...(owner ? { project: { machine: { ownerId: owner } } } : {}) },
      orderBy: [{ projectId: 'asc' }, { position: 'asc' }],
    });
    return rows.map(mapTask);
  }
}
