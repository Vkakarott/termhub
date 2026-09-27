import type { PrismaClient } from '../prisma.js';
import type { ChatLiveRun as PrismaChatLiveRun } from '../../generated/prisma/client.js';

/** One in-flight turn at the moment a live run was last saved: enough for a resuming instance to
 * settle it (both ids set) or replay it (an answer never finished). `text` is the input that was
 * written to the CLI for this turn — the person's own words plus any context the server put in front
 * (a tab question's) — so a replay sends exactly the same line again. It is chat content: never log
 * it; ids only. */
export interface StoredTurn {
  question_id: string | null;
  answer_id: string | null;
  text: string;
}

/** The one concierge CLI process a conversation is running right now, kept across a server restart
 * (spec 2026-09-26 §6). */
export interface ChatLiveRun {
  conversation_id: string;
  user_id: string;
  instance_id: string;
  heartbeat_at: string;
  released_at: string | null;
  turns: StoredTurn[];
  created_at: string;
}

/** The owner of a row handed back after a failed resume: no instance ever has this id. */
export const RELEASED_INSTANCE = 'released';

export interface SaveLiveRunInput {
  conversation_id: string;
  user_id: string;
  instance_id: string;
  turns: StoredTurn[];
}

const mapLiveRun = (r: PrismaChatLiveRun): ChatLiveRun => ({
  conversation_id: r.conversationId,
  user_id: r.userId,
  instance_id: r.instanceId,
  heartbeat_at: r.heartbeatAt.toISOString(),
  released_at: r.releasedAt?.toISOString() ?? null,
  turns: r.turns as unknown as StoredTurn[],
  created_at: r.createdAt.toISOString(),
});

export class ChatLiveRunsRepository {
  constructor(private db: PrismaClient) {}

  /** Records (or takes over) the process running one conversation. One row per conversation — the
   * pkey — so a save always replaces whatever the previous owner left, resets the heartbeat clock and
   * clears `released_at`: this instance now owns it, live. */
  async save(input: SaveLiveRunInput): Promise<void> {
    const now = new Date();
    await this.db.chatLiveRun.upsert({
      where: { conversationId: input.conversation_id },
      create: {
        conversationId: input.conversation_id,
        userId: input.user_id,
        instanceId: input.instance_id,
        turns: input.turns as never,
        heartbeatAt: now,
        releasedAt: null,
      },
      update: {
        userId: input.user_id,
        instanceId: input.instance_id,
        turns: input.turns as never,
        heartbeatAt: now,
        releasedAt: null,
      },
    });
  }

  /** Proves this instance's runs are still alive: every row it owns gets a fresh `heartbeat_at`, so a
   * peer never claims it as stale. Returns how many rows it touched. */
  async heartbeat(instanceId: string): Promise<number> {
    const { count } = await this.db.chatLiveRun.updateMany({ where: { instanceId }, data: { heartbeatAt: new Date() } });
    return count;
  }

  /** A clean shutdown: every row this instance owns is marked resumable immediately (not only once its
   * heartbeat goes stale), and `turnsByConversation` — when given — replaces each row's stored turns
   * with what the process had in flight the moment it let go. Returns how many rows were released. */
  async release(instanceId: string, turnsByConversation?: Map<string, StoredTurn[]>): Promise<number> {
    const rows = await this.db.chatLiveRun.findMany({ where: { instanceId }, select: { conversationId: true } });
    if (rows.length === 0) return 0;
    const now = new Date();
    await this.db.$transaction(
      rows.map((r) => {
        const turns = turnsByConversation?.get(r.conversationId);
        return this.db.chatLiveRun.update({
          where: { conversationId: r.conversationId },
          data: { releasedAt: now, ...(turns === undefined ? {} : { turns: turns as never }) },
        });
      }),
    );
    return rows.length;
  }

  /** What another instance may pick up: every row not its own that is either released or stale
   * (`heartbeat_at` older than `staleBefore`) — never its own, even if that row happens to look stale
   * to itself, since an instance always knows better than the clock whether its own run is alive. */
  async listResumable(instanceId: string, staleBefore: Date): Promise<ChatLiveRun[]> {
    const rows = await this.db.chatLiveRun.findMany({
      where: {
        instanceId: { not: instanceId },
        OR: [{ releasedAt: { not: null } }, { heartbeatAt: { lt: staleBefore } }],
      },
    });
    return rows.map(mapLiveRun);
  }

  /**
   * Takes over one conversation's row from `fromInstance` to `toInstance`, but only under the same
   * "resumable" predicate `listResumable` used to find it: a single conditional `UPDATE`, so when two
   * instances race to resume the same stale-looking row the database decides exactly one winner and
   * the other sees `false` instead of silently double-running the same CLI process.
   */
  async claim(conversationId: string, fromInstance: string, toInstance: string, staleBefore: Date): Promise<boolean> {
    const { count } = await this.db.chatLiveRun.updateMany({
      where: {
        conversationId,
        instanceId: fromInstance,
        OR: [{ releasedAt: { not: null } }, { heartbeatAt: { lt: staleBefore } }],
      },
      data: { instanceId: toInstance, releasedAt: null, heartbeatAt: new Date() },
    });
    return count === 1;
  }

  /** `listResumable` for one conversation: its row when another instance released it or left it stale,
   *  else null — what a run about to start on this instance must take over instead of overwriting. */
  async findResumable(conversationId: string, instanceId: string, staleBefore: Date): Promise<ChatLiveRun | null> {
    const row = await this.db.chatLiveRun.findFirst({
      where: {
        conversationId,
        instanceId: { not: instanceId },
        OR: [{ releasedAt: { not: null } }, { heartbeatAt: { lt: staleBefore } }],
      },
    });
    return row ? mapLiveRun(row) : null;
  }

  /** The opposite of `findResumable`: the conversation's row when another instance owns it, has not
   *  released it and beat at or after `freshAfter` — its process is alive over there (the blue/green
   *  overlap), so this instance must not act as if it were gone. Null otherwise. */
  async findLiveElsewhere(conversationId: string, instanceId: string, freshAfter: Date): Promise<ChatLiveRun | null> {
    const row = await this.db.chatLiveRun.findFirst({
      where: { conversationId, instanceId: { not: instanceId }, releasedAt: null, heartbeatAt: { gte: freshAfter } },
    });
    return row ? mapLiveRun(row) : null;
  }

  /**
   * Gives a claimed row back to every instance — this one included — after its resume failed: it moves
   * to `RELEASED_INSTANCE`, an id no live instance has, so `listResumable` lists it to all of them.
   * `releasedAt` is the row's original release (or last heartbeat), never now: a failure must not reset
   * the window after which its turns are given up. Conditional on still owning it; false otherwise.
   */
  async handBack(conversationId: string, fromInstance: string, releasedAt: Date): Promise<boolean> {
    const { count } = await this.db.chatLiveRun.updateMany({
      where: { conversationId, instanceId: fromInstance },
      data: { instanceId: RELEASED_INSTANCE, releasedAt },
    });
    return count === 1;
  }

  /** Only this instance's row for the conversation — never another's, so an instance can never delete
   * a run it does not own (a resumed conversation whose original owner is shutting down late). */
  async delete(conversationId: string, instanceId: string): Promise<void> {
    await this.db.chatLiveRun.deleteMany({ where: { conversationId, instanceId } });
  }
}
