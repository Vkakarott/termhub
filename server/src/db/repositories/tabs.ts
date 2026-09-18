import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapTab, type Tab, type TabKind } from './types.js';

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

  async create(projectId: string, name: string, opts: { kind?: TabKind; simulator_udid?: string | null } = {}): Promise<Tab> {
    const id = newId();
    const kind = opts.kind ?? 'terminal';
    const agg = await this.db.tab.aggregate({ where: { projectId }, _max: { position: true } });
    const t = await this.db.tab.create({
      data: {
        id,
        projectId,
        name,
        kind,
        tmuxSession: kind === 'terminal' ? `termhub-${projectId}-${id}` : null,
        simulatorUdid: kind === 'simulator' ? (opts.simulator_udid ?? null) : null,
        position: (agg._max.position ?? -1) + 1,
      },
    });
    return mapTab(t);
  }

  async update(id: string, patch: { name?: string; simulator_udid?: string | null }): Promise<Tab | undefined> {
    const data: { name?: string; simulatorUdid?: string | null } = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.simulator_udid !== undefined) data.simulatorUdid = patch.simulator_udid;
    const t = await this.db.tab.update({ where: { id }, data });
    return mapTab(t);
  }

  async rename(id: string, name: string): Promise<Tab | undefined> {
    return this.update(id, { name });
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.tab.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
