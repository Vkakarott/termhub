import type { PrismaClient } from '../prisma.js';
import type { ChatAction as PrismaChatAction } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type ChatActionClass = 'read' | 'write' | 'irreversible';
export type ChatActionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';

const OPEN_STATUSES: ChatActionStatus[] = ['pending', 'approved'];

/** One action the concierge proposed, and what became of it. `args` is never a tool result's
 * payload — no screen contents, no command output — only what was proposed (spec §7.1). */
export interface ChatAction {
  id: string;
  conversation_id: string;
  message_id: string | null;
  tool: string;
  args: unknown;
  class: ChatActionClass;
  status: ChatActionStatus;
  idempotency_key: string | null;
  machine_id: string | null;
  project_id: string | null;
  tab_id: string | null;
  error_code: string | null;
  duration_ms: number | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface InsertPendingInput {
  conversation_id: string;
  tool: string;
  args: unknown;
  class: ChatActionClass;
  message_id?: string | null;
  idempotency_key?: string | null;
  machine_id?: string | null;
  project_id?: string | null;
  tab_id?: string | null;
}

const mapAction = (a: PrismaChatAction): ChatAction => ({
  id: a.id,
  conversation_id: a.conversationId,
  message_id: a.messageId,
  tool: a.tool,
  args: a.args,
  class: a.class as ChatActionClass,
  status: a.status as ChatActionStatus,
  idempotency_key: a.idempotencyKey,
  machine_id: a.machineId,
  project_id: a.projectId,
  tab_id: a.tabId,
  error_code: a.errorCode,
  duration_ms: a.durationMs,
  decided_by: a.decidedBy,
  decided_at: a.decidedAt?.toISOString() ?? null,
  created_at: a.createdAt.toISOString(),
});

export class ChatActionsRepository {
  constructor(private db: PrismaClient) {}

  /** The open (pending or approved) row for a key, or undefined once it has been decided one way
   * or the other — the partial unique index in the migration is what actually prevents two open
   * rows for the same key from existing at once; this is just the matching read. */
  async findOpenByKey(conversationId: string, idempotencyKey: string): Promise<ChatAction | undefined> {
    const row = await this.db.chatAction.findFirst({
      where: { conversationId, idempotencyKey, status: { in: OPEN_STATUSES } },
    });
    return row ? mapAction(row) : undefined;
  }

  /**
   * The newest "no" the user gave for a key. `findOpenByKey` cannot see a decided row, and the partial
   * unique index deliberately lets a key be proposed again once it is decided — right for an executed
   * action, since the same command may legitimately be run twice, and wrong for one refused a moment
   * ago, which the model would otherwise just retry. How long a "no" keeps refusing is the gate's call,
   * not this read's: it returns the row and its `decided_at`. An `expired` row is not a "no" at all —
   * nobody answered it — so it is not returned and the question gets asked again.
   */
  async findDeniedByKey(conversationId: string, idempotencyKey: string): Promise<ChatAction | undefined> {
    const row = await this.db.chatAction.findFirst({
      where: { conversationId, idempotencyKey, status: 'denied' satisfies ChatActionStatus },
      orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? mapAction(row) : undefined;
  }

  async insertPending(input: InsertPendingInput): Promise<ChatAction> {
    const row = await this.db.chatAction.create({
      data: {
        id: newId(),
        conversationId: input.conversation_id,
        messageId: input.message_id ?? null,
        tool: input.tool,
        args: input.args as never,
        class: input.class,
        status: 'pending',
        idempotencyKey: input.idempotency_key ?? null,
        machineId: input.machine_id ?? null,
        projectId: input.project_id ?? null,
        tabId: input.tab_id ?? null,
      },
    });
    return mapAction(row);
  }

  /**
   * Records the user's decision on a pending action. Filtered by `id` **and** the owning
   * conversation's `user_id` in the same query, so another user's row is refused in SQL — a
   * handler-level check would be bypassable by the next caller. Undefined when it matched nothing
   * (wrong user, wrong id, or already decided).
   */
  async decide(id: string, userId: string, status: 'approved' | 'denied'): Promise<ChatAction | undefined> {
    const { count } = await this.db.chatAction.updateMany({
      where: { id, status: 'pending', conversation: { userId } },
      data: { status, decidedBy: userId, decidedAt: new Date() },
    });
    if (count === 0) return undefined;
    const row = await this.db.chatAction.findUnique({ where: { id } });
    return row ? mapAction(row) : undefined;
  }

  async markExecuted(id: string, ok: boolean, errorCode?: string | null, durationMs?: number | null): Promise<void> {
    await this.db.chatAction.updateMany({
      where: { id },
      data: { status: ok ? 'executed' : 'failed', errorCode: errorCode ?? null, durationMs: durationMs ?? null },
    });
  }

  async listByConversation(conversationId: string, limit = 200): Promise<ChatAction[]> {
    const rows = await this.db.chatAction.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.reverse().map(mapAction);
  }

  /** Moves stale pending rows to `expired`; approved-but-not-yet-executed rows are left alone.
   * Returns the number of rows changed. */
  async expireOlderThan(cutoff: Date): Promise<number> {
    const { count } = await this.db.chatAction.updateMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      data: { status: 'expired' },
    });
    return count;
  }
}
