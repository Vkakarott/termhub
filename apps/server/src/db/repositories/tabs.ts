import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapTab, mapTabEvent, type Tab, type TabEvent, type TabKind, type TabState } from './types.js';

/** A flood of hook events cannot grow the log without bound: only this many are kept per tab. */
const EVENTS_KEPT_PER_TAB = 200;

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

  /** Tab by tmux session name, restricted to the machine that reported it (session names are unique anyway). */
  async findByTmuxSession(machineId: string, session: string): Promise<Tab | undefined> {
    const t = await this.db.tab.findFirst({ where: { tmuxSession: session, project: { machineId } } });
    return t ? mapTab(t) : undefined;
  }

  /** Tabs whose tool reported a state (monitor list). `owner`: only tabs on that user's machines (null = all). */
  async listWithState(owner: string | null = null): Promise<Tab[]> {
    const rows = await this.db.tab.findMany({
      where: { state: { not: null }, ...(owner ? { project: { machine: { ownerId: owner } } } : {}) },
      orderBy: [{ stateAt: 'desc' }],
    });
    return rows.map(mapTab);
  }

  /** Monitor: records the event and makes it the tab's current state; keeps only the newest events per tab. */
  async recordEvent(tabId: string, event: { kind: TabState; tool: string; text: string | null; meta?: Record<string, unknown> }): Promise<{ tab: Tab; event: TabEvent }> {
    const at = new Date();
    const [e, t] = await this.db.$transaction([
      this.db.tabEvent.create({ data: { id: newId(), tabId, kind: event.kind, tool: event.tool, text: event.text, meta: (event.meta ?? {}) as object, createdAt: at } }),
      this.db.tab.update({ where: { id: tabId }, data: { state: event.kind, stateText: event.text, stateTool: event.tool, stateAt: at } }),
      this.db.$executeRaw`DELETE FROM "tab_events" WHERE "tab_id" = ${tabId} AND "id" NOT IN (SELECT "id" FROM "tab_events" WHERE "tab_id" = ${tabId} ORDER BY "created_at" DESC LIMIT ${EVENTS_KEPT_PER_TAB})`,
    ]);
    return { tab: mapTab(t), event: mapTabEvent(e) };
  }

  async listEvents(tabId: string, limit = 50): Promise<TabEvent[]> {
    const rows = await this.db.tabEvent.findMany({ where: { tabId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(mapTabEvent);
  }

  /** Clears the monitor state (e.g. the tmux session is gone). */
  async clearState(tabId: string): Promise<void> {
    await this.db.tab.updateMany({ where: { id: tabId }, data: { state: null, stateText: null, stateTool: null, stateAt: null } });
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
