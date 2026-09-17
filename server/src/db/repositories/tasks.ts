import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapTask, type Task, type TaskStatus } from './types.js';

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

  /**
   * Sincroniza tickets externos com o kanban do projeto.
   * - novo ticket → cria task (no fim da coluna do status mapeado)
   * - existente → atualiza título/descrição/external_ref; move de coluna só se o status externo mudou
   *   desde o último sync (respeita movimentações feitas no kanban)
   */
  async upsertExternal(
    projectId: string,
    tickets: { key: string; title: string; description: string | null; status: TaskStatus; ref: Record<string, unknown> }[],
  ): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    for (const t of tickets) {
      const existing = await this.db.task.findUnique({ where: { projectId_externalKey: { projectId, externalKey: t.key } } });
      if (!existing) {
        const agg = await this.db.task.aggregate({ where: { projectId, status: t.status }, _max: { position: true } });
        await this.db.task.create({
          data: {
            id: newId(),
            projectId,
            title: t.title,
            description: t.description,
            status: t.status,
            position: (agg._max.position ?? -1) + 1,
            externalKey: t.key,
            externalRef: t.ref as object,
          },
        });
        created++;
        continue;
      }
      const prevRef = (existing.externalRef ?? {}) as { status?: string };
      const externalStatusChanged = prevRef.status !== t.status;
      const changed =
        existing.title !== t.title || (existing.description ?? null) !== (t.description ?? null) || externalStatusChanged || stableStringify(existing.externalRef) !== stableStringify(t.ref);
      if (!changed) continue;
      await this.db.task.update({
        where: { id: existing.id },
        data: { title: t.title, description: t.description, externalRef: t.ref as object },
      });
      if (externalStatusChanged && existing.status !== t.status) await this.move(existing.id, t.status, 0);
      updated++;
    }
    return { created, updated };
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
