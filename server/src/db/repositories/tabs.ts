import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapTab, type Tab } from './types.js';

export class TabsRepository {
  constructor(private db: PrismaClient) {}

  async listByProject(projectId: string): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({ where: { projectId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(mapTab);
  }

  async findById(id: string): Promise<Tab | undefined> {
    const t = await this.db.tab.findUnique({ where: { id } });
    return t ? mapTab(t) : undefined;
  }

  async create(projectId: string, name: string): Promise<Tab> {
    const id = newId();
    const agg = await this.db.tab.aggregate({ where: { projectId }, _max: { position: true } });
    const t = await this.db.tab.create({
      data: { id, projectId, name, tmuxSession: `termhub-${projectId}-${id}`, position: (agg._max.position ?? -1) + 1 },
    });
    return mapTab(t);
  }

  async rename(id: string, name: string): Promise<Tab | undefined> {
    const t = await this.db.tab.update({ where: { id }, data: { name } });
    return mapTab(t);
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.tab.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
