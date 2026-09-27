import type { PrismaClient } from '../prisma.js';
import type { ChatSubagent as PrismaChatSubagent } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import type { SubagentStatus } from '../../chat/stream.js';
import { PANEL_MAX, PANEL_RECENT_MS } from '../../chat/subagent-view.js';

const FINAL_STATUSES: SubagentStatus[] = ['completed', 'failed', 'stopped', 'interrupted'];
const OPEN_STATUSES: SubagentStatus[] = ['running', 'stopping'];

/** A Task-tool subagent run inside a conversation's CLI session (spec 2026-09-26 §4). */
export interface ChatSubagent {
  id: string;
  conversation_id: string;
  task_id: string;
  tool_use_id: string;
  description: string;
  subagent_type: string | null;
  status: SubagentStatus;
  started_at: string;
  ended_at: string | null;
}

export interface StartSubagentInput {
  conversation_id: string;
  task_id: string;
  tool_use_id: string;
  description: string;
  subagent_type: string | null;
}

const mapSubagent = (s: PrismaChatSubagent): ChatSubagent => ({
  id: s.id,
  conversation_id: s.conversationId,
  task_id: s.taskId,
  tool_use_id: s.toolUseId,
  description: s.description,
  subagent_type: s.subagentType,
  status: s.status as SubagentStatus,
  started_at: s.startedAt.toISOString(),
  ended_at: s.endedAt?.toISOString() ?? null,
});

export class ChatSubagentsRepository {
  constructor(private db: PrismaClient) {}

  /** `task_started` for a task the CLI already told us about (a duplicate frame, a retried delivery)
   * must not create a second row or overwrite what is already there: the compound unique index on
   * `(conversation_id, task_id)` is what makes this an upsert instead of a create, and the empty
   * `update` is what makes a repeat a no-op read of the existing row. */
  async start(input: StartSubagentInput): Promise<ChatSubagent> {
    const row = await this.db.chatSubagent.upsert({
      where: { conversationId_taskId: { conversationId: input.conversation_id, taskId: input.task_id } },
      create: {
        id: newId(),
        conversationId: input.conversation_id,
        taskId: input.task_id,
        toolUseId: input.tool_use_id,
        description: input.description,
        subagentType: input.subagent_type,
        status: 'running' satisfies SubagentStatus,
      },
      update: {},
    });
    return mapSubagent(row);
  }

  /** `ended_at` follows the status: set the moment it lands on one of the final states, cleared if it
   * is ever reported running again (a CLI that revives a task id it once ended). Undefined when the
   * row is already gone (its conversation was deleted). */
  async setStatus(id: string, status: SubagentStatus): Promise<ChatSubagent | undefined> {
    const ended = FINAL_STATUSES.includes(status);
    const { count } = await this.db.chatSubagent.updateMany({
      where: { id },
      data: { status, endedAt: ended ? new Date() : null },
    });
    if (count === 0) return undefined;
    const row = await this.db.chatSubagent.findUnique({ where: { id } });
    return row ? mapSubagent(row) : undefined;
  }

  /** Scoped through the owning conversation's `user_id`, like `ChatActionsRepository.findByIdForUser`:
   * another user's row and no row at all are the same `undefined`. */
  async findByIdForUser(id: string, userId: string): Promise<ChatSubagent | undefined> {
    const row = await this.db.chatSubagent.findFirst({ where: { id, conversation: { userId } } });
    return row ? mapSubagent(row) : undefined;
  }

  /** The panel's list (spec 2026-09-26 §4): every subagent still open, plus any that ended within the
   * last `PANEL_RECENT_MS` — newest first, capped at `PANEL_MAX` so a chatty session cannot flood it. */
  async listForPanel(conversationId: string, now = new Date()): Promise<ChatSubagent[]> {
    const rows = await this.db.chatSubagent.findMany({
      where: {
        conversationId,
        OR: [{ status: { in: OPEN_STATUSES } }, { endedAt: { gte: new Date(now.getTime() - PANEL_RECENT_MS) } }],
      },
      orderBy: { startedAt: 'desc' },
      take: PANEL_MAX,
    });
    return rows.map(mapSubagent);
  }

  /** A restart (or a lost CLI process) leaves whatever was running with no way to ever report a final
   * status: this is how the panel stops showing them as still going. Returns only the rows it changed. */
  async interruptRunning(conversationId: string): Promise<ChatSubagent[]> {
    const rows = await this.db.chatSubagent.findMany({ where: { conversationId, status: { in: OPEN_STATUSES } } });
    if (rows.length === 0) return [];
    const now = new Date();
    await this.db.chatSubagent.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: 'interrupted' satisfies SubagentStatus, endedAt: now },
    });
    return rows.map((r) => mapSubagent({ ...r, status: 'interrupted', endedAt: now }));
  }

  async listByIds(ids: string[]): Promise<ChatSubagent[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.chatSubagent.findMany({ where: { id: { in: ids } } });
    return rows.map(mapSubagent);
  }
}
