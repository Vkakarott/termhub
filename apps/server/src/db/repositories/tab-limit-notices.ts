import type { PrismaClient } from '../prisma.js';
import type { TabLimitNotice as PrismaTabLimitNotice } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type TabLimitStatus = 'open' | 'swapped' | 'dismissed' | 'expired' | 'failed';

/** What the card says (spec 2026-09-30 project AI accounts §7.2). Labels, never paths. */
export interface TabLimitPayload {
  /** the account that hit the limit; null when the tab runs a login termhub does not know */
  account: { id: string; label: string } | null;
  machine: { id: string; name: string };
  /** when the fullest window of that account resets, when known */
  resets_at: string | null;
  /** the project's other accounts on that machine with room, in priority order */
  candidates: { id: string; label: string }[];
}

export interface TabLimitNotice {
  id: string;
  tab_id: string;
  project_id: string;
  conversation_id: string;
  /** the conversation's owner, who alone may answer the card */
  user_id: string;
  limited_at: string;
  payload: TabLimitPayload;
  status: TabLimitStatus;
  result: string | null;
  created_at: string;
  closed_at: string | null;
}

type Row = PrismaTabLimitNotice & { conversation: { userId: string } };
const withOwner = { conversation: { select: { userId: true } } } as const;

const map = (r: Row): TabLimitNotice => ({
  id: r.id,
  tab_id: r.tabId,
  project_id: r.projectId,
  conversation_id: r.conversationId,
  user_id: r.conversation.userId,
  limited_at: r.limitedAt.toISOString(),
  payload: r.payload as unknown as TabLimitPayload,
  status: r.status as TabLimitStatus,
  result: r.result,
  created_at: r.createdAt.toISOString(),
  closed_at: r.closedAt?.toISOString() ?? null,
});

/** How many cards `GET /chat` carries: the open ones and the latest closed, newest first. */
export const LIST_TAB_LIMITS_MAX = 20;

export class TabLimitNoticesRepository {
  constructor(private db: PrismaClient) {}

  /** Opens the incident's card; undefined when this incident already has one (the unique key). */
  async open(input: { tab_id: string; project_id: string; conversation_id: string; limited_at: Date; payload: TabLimitPayload }): Promise<TabLimitNotice | undefined> {
    const created = await this.db.tabLimitNotice.createMany({
      data: [{ id: newId(), tabId: input.tab_id, projectId: input.project_id, conversationId: input.conversation_id, limitedAt: input.limited_at, payload: input.payload as object, status: 'open' }],
      skipDuplicates: true,
    });
    if (created.count === 0) return undefined;
    const row = await this.db.tabLimitNotice.findUnique({ where: { tabId_limitedAt: { tabId: input.tab_id, limitedAt: input.limited_at } }, include: withOwner });
    return row ? map(row) : undefined;
  }

  /** The card, only for its conversation's owner. */
  async findForUser(id: string, userId: string): Promise<TabLimitNotice | undefined> {
    const row = await this.db.tabLimitNotice.findFirst({ where: { id, conversation: { userId } }, include: withOwner });
    return row ? map(row) : undefined;
  }

  /** Closes an open card, once: undefined when it was no longer open (a second click, a race). */
  async close(id: string, status: Exclude<TabLimitStatus, 'open'>, result: string | null = null): Promise<TabLimitNotice | undefined> {
    const done = await this.db.tabLimitNotice.updateMany({ where: { id, status: 'open' }, data: { status, result, closedAt: new Date() } });
    if (done.count === 0) return undefined;
    const row = await this.db.tabLimitNotice.findUnique({ where: { id }, include: withOwner });
    return row ? map(row) : undefined;
  }

  /** Every open card of the tab, closed as `status` (the limit ended, the tab was removed). */
  async closeOpenForTab(tabId: string, status: Exclude<TabLimitStatus, 'open'>): Promise<TabLimitNotice[]> {
    const open = await this.db.tabLimitNotice.findMany({ where: { tabId, status: 'open' }, select: { id: true } });
    const closed: TabLimitNotice[] = [];
    for (const { id } of open) {
      const row = await this.close(id, status);
      if (row) closed.push(row);
    }
    return closed;
  }

  async listByConversation(conversationId: string): Promise<TabLimitNotice[]> {
    const rows = await this.db.tabLimitNotice.findMany({ where: { conversationId }, include: withOwner, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: LIST_TAB_LIMITS_MAX });
    return rows.map(map);
  }
}
