import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { ensureDefaultColumns, lockProject, type Tx } from './task-board.js';
import { MAX_COLUMNS, TaskRuleError } from './task-rules.js';
import { mapTaskColumn, type ColumnCategory, type TaskColumn } from './types.js';

const ORDER = [{ position: 'asc' as const }, { createdAt: 'asc' as const }];

/** A project's board columns (spec §2 `task_columns`, rules §3 "Columns"). Every write locks the project. */
export class TaskColumnsRepository {
  constructor(private db: PrismaClient) {}

  async list(projectId: string): Promise<TaskColumn[]> {
    return (await this.db.taskColumn.findMany({ where: { projectId }, orderBy: ORDER })).map(mapTaskColumn);
  }

  async findById(id: string): Promise<TaskColumn | undefined> {
    const c = await this.db.taskColumn.findUnique({ where: { id } });
    return c ? mapTaskColumn(c) : undefined;
  }

  /** "A fazer", "Fazendo", "Feito" for a project with no column (one made by the previous release). */
  async ensureDefaults(projectId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await ensureDefaultColumns(tx, projectId);
    });
  }

  /** Appended at the end. At most MAX_COLUMNS per project. */
  async create(projectId: string, input: { name: string; category: ColumnCategory }): Promise<TaskColumn> {
    return this.db.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      await ensureDefaultColumns(tx, projectId);
      const count = await tx.taskColumn.count({ where: { projectId } });
      if (count >= MAX_COLUMNS) throw new TaskRuleError('TOO_MANY_COLUMNS');
      const c = await tx.taskColumn.create({ data: { id: newId(), projectId, name: input.name, category: input.category, position: count } });
      return mapTaskColumn(c);
    });
  }

  async rename(id: string, name: string): Promise<TaskColumn | undefined> {
    const r = await this.db.taskColumn.updateMany({ where: { id }, data: { name } });
    return r.count ? this.findById(id) : undefined;
  }

  /** The column's cards take the new category as their status in the same transaction. */
  async setCategory(id: string, category: ColumnCategory): Promise<TaskColumn | undefined> {
    return this.db.$transaction(async (tx) => {
      const col = await this.locked(tx, id);
      if (!col) return undefined;
      if (col.category !== category) {
        await this.refuseLastOfCategory(tx, col);
        await tx.taskColumn.update({ where: { id }, data: { category } });
        await tx.task.updateMany({ where: { columnId: id }, data: { status: category } });
        // the agent column must stay a doing column; otherwise the project goes back to automatic
        if (category !== 'doing') await tx.project.updateMany({ where: { id: col.projectId, agentColumnId: id }, data: { agentColumnId: null } });
      }
      return mapTaskColumn(await tx.taskColumn.findUniqueOrThrow({ where: { id } }));
    });
  }

  /** Moves the column to `position` (clamped) and answers the project's columns in their new order. */
  async move(id: string, position: number): Promise<TaskColumn[] | undefined> {
    return this.db.$transaction(async (tx) => {
      const col = await this.locked(tx, id);
      if (!col) return undefined;
      const cols = await tx.taskColumn.findMany({ where: { projectId: col.projectId }, orderBy: ORDER, select: { id: true, position: true } });
      const ids = cols.map((c) => c.id).filter((c) => c !== id);
      ids.splice(Math.max(0, Math.min(Math.trunc(position), ids.length)), 0, id);
      for (const [i, colId] of ids.entries()) {
        if (cols.find((c) => c.id === colId)?.position !== i) await tx.taskColumn.update({ where: { id: colId }, data: { position: i } });
      }
      return (await tx.taskColumn.findMany({ where: { projectId: col.projectId }, orderBy: ORDER })).map(mapTaskColumn);
    });
  }

  /**
   * Deletes the column; its cards go, in order, to the end of the first other column of the same
   * category. A project that pointed its agent column here falls back to automatic (FK SET NULL).
   */
  async delete(id: string): Promise<{ moved_tasks: number } | undefined> {
    return this.db.$transaction(async (tx) => {
      const col = await this.locked(tx, id);
      if (!col) return undefined;
      const target = await tx.taskColumn.findFirst({ where: { projectId: col.projectId, category: col.category, id: { not: id } }, orderBy: ORDER, select: { id: true } });
      if (!target) throw new TaskRuleError('COLUMN_LAST_OF_CATEGORY');
      const cards = await tx.task.findMany({ where: { columnId: id }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
      const agg = await tx.task.aggregate({ where: { columnId: target.id }, _max: { position: true } });
      let next = (agg._max.position ?? -1) + 1;
      for (const c of cards) await tx.task.update({ where: { id: c.id }, data: { columnId: target.id, position: next++ } });
      await tx.taskColumn.delete({ where: { id } });
      const rest = await tx.taskColumn.findMany({ where: { projectId: col.projectId }, orderBy: ORDER, select: { id: true, position: true } });
      for (const [i, c] of rest.entries()) if (c.position !== i) await tx.taskColumn.update({ where: { id: c.id }, data: { position: i } });
      return { moved_tasks: cards.length };
    });
  }

  /** null = automatic (the first `doing` column). A set column must be one of the project's `doing` columns. */
  async setAgentColumn(projectId: string, columnId: string | null): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (columnId) {
        const col = await tx.taskColumn.findFirst({ where: { id: columnId, projectId }, select: { category: true } });
        if (!col) throw new TaskRuleError('COLUMN_NOT_FOUND');
        if (col.category !== 'doing') throw new TaskRuleError('COLUMN_NOT_DOING');
      }
      await tx.project.update({ where: { id: projectId }, data: { agentColumnId: columnId } });
    });
  }

  /** The column, re-read after locking its project (null when it does not exist). */
  private async locked(tx: Tx, id: string) {
    const col = await tx.taskColumn.findUnique({ where: { id }, select: { projectId: true } });
    if (!col) return null;
    await lockProject(tx, col.projectId);
    return tx.taskColumn.findUnique({ where: { id } });
  }

  private async refuseLastOfCategory(tx: Tx, col: { id: string; projectId: string; category: string }): Promise<void> {
    const others = await tx.taskColumn.count({ where: { projectId: col.projectId, category: col.category as ColumnCategory, id: { not: col.id } } });
    if (others === 0) throw new TaskRuleError('COLUMN_LAST_OF_CATEGORY');
  }
}
