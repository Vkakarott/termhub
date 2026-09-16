import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapTask, type Task, type TaskStatus } from './types.js';

export interface TaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
}

export class TasksRepository {
  constructor(private db: PrismaClient) {}

  async listByProject(projectId: string): Promise<Task[]> {
    const rows = await this.db.task.findMany({ where: { projectId }, orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTask);
  }

  async findById(id: string): Promise<Task | undefined> {
    const t = await this.db.task.findUnique({ where: { id } });
    return t ? mapTask(t) : undefined;
  }

  /** Cria no topo da coluna (position 0), empurrando as demais. */
  async create(projectId: string, input: TaskInput): Promise<Task> {
    const status = input.status ?? 'todo';
    return this.db.$transaction(async (tx) => {
      await tx.task.updateMany({ where: { projectId, status }, data: { position: { increment: 1 } } });
      const t = await tx.task.create({
        data: { id: newId(), projectId, title: input.title, description: input.description ?? null, status, position: 0 },
      });
      return mapTask(t);
    });
  }

  async update(id: string, patch: Partial<TaskInput>): Promise<Task | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    if (patch.status && patch.status !== current.status) {
      return this.move(id, patch.status, 0, { title: patch.title, description: patch.description });
    }
    const t = await this.db.task.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      },
    });
    return mapTask(t);
  }

  /** Move para (status, position) reordenando as colunas de origem e destino. */
  async move(id: string, status: TaskStatus, position: number, extra?: { title?: string; description?: string | null }): Promise<Task | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    return this.db.$transaction(async (tx) => {
      // remove da coluna de origem
      await tx.task.updateMany({
        where: { projectId: current.project_id, status: current.status, position: { gt: current.position } },
        data: { position: { decrement: 1 } },
      });
      const count = await tx.task.count({ where: { projectId: current.project_id, status, id: { not: id } } });
      const pos = Math.max(0, Math.min(position, count));
      // abre espaço na coluna de destino
      await tx.task.updateMany({
        where: { projectId: current.project_id, status, position: { gte: pos }, id: { not: id } },
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

  async delete(id: string): Promise<boolean> {
    const current = await this.findById(id);
    if (!current) return false;
    await this.db.$transaction(async (tx) => {
      await tx.task.delete({ where: { id } });
      await tx.task.updateMany({
        where: { projectId: current.project_id, status: current.status, position: { gt: current.position } },
        data: { position: { decrement: 1 } },
      });
    });
    return true;
  }

  /** Contagem de tasks abertas (todo + doing) por projeto. */
  async openCountByProject(): Promise<Record<string, number>> {
    const rows = await this.db.task.groupBy({ by: ['projectId'], where: { status: { in: ['todo', 'doing'] } }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.projectId, r._count._all]));
  }

  async listDoing(): Promise<Task[]> {
    const rows = await this.db.task.findMany({ where: { status: 'doing' }, orderBy: [{ projectId: 'asc' }, { position: 'asc' }] });
    return rows.map(mapTask);
  }
}
