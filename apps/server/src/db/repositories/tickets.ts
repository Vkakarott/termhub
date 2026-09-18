import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapTicket, type Ticket, type TaskStatus } from './types.js';

export interface TicketUpsert {
  integration_id: string;
  provider: 'github' | 'linear' | 'jira';
  external_key: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: string;
  status: TaskStatus;
  meta: Record<string, unknown>;
}

/** Staging dos tickets sincronizados. Viram task só via importação explícita. */
export class TicketsRepository {
  constructor(private db: PrismaClient) {}

  async listByProject(projectId: string, integrationId?: string): Promise<Ticket[]> {
    const rows = await this.db.ticket.findMany({
      where: { projectId, ...(integrationId ? { integrationId } : {}) },
      orderBy: [{ status: 'asc' }, { syncedAt: 'desc' }],
    });
    return rows.map(mapTicket);
  }

  async findByIds(projectId: string, ids: string[]): Promise<Ticket[]> {
    return (await this.db.ticket.findMany({ where: { projectId, id: { in: ids } } })).map(mapTicket);
  }

  /** Upsert em lote; devolve os tickets que já têm task (para atualizar o espelho). */
  async upsertMany(projectId: string, items: TicketUpsert[]): Promise<{ created: number; updated: number; linked: Ticket[] }> {
    let created = 0;
    let updated = 0;
    const linked: Ticket[] = [];
    const now = new Date();
    for (const t of items) {
      const existing = await this.db.ticket.findUnique({ where: { projectId_externalKey: { projectId, externalKey: t.external_key } } });
      const data = {
        integrationId: t.integration_id,
        provider: t.provider,
        identifier: t.identifier,
        title: t.title,
        description: t.description,
        url: t.url,
        state: t.state,
        status: t.status,
        meta: t.meta as object,
        syncedAt: now,
      };
      if (!existing) {
        await this.db.ticket.create({ data: { id: newId(), projectId, externalKey: t.external_key, ...data } });
        created++;
        continue;
      }
      const changed =
        existing.title !== t.title || (existing.description ?? null) !== t.description || existing.state !== t.state || existing.url !== t.url;
      const row = await this.db.ticket.update({ where: { id: existing.id }, data });
      if (changed) updated++;
      if (row.taskId) linked.push(mapTicket(row));
    }
    return { created, updated, linked };
  }

  async linkTask(ticketId: string, taskId: string): Promise<void> {
    await this.db.ticket.update({ where: { id: ticketId }, data: { taskId } });
  }

  async unlinkTask(taskId: string): Promise<void> {
    await this.db.ticket.updateMany({ where: { taskId }, data: { taskId: null } });
  }

  /** Remove tickets que sumiram da fonte e não foram importados. */
  async pruneMissing(projectId: string, integrationId: string, keepKeys: string[]): Promise<number> {
    const r = await this.db.ticket.deleteMany({ where: { projectId, integrationId, taskId: null, externalKey: { notIn: keepKeys } } });
    return r.count;
  }
}
