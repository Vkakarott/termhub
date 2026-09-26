import type { PrismaClient } from '../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

/** One option offered by a remembered `AskUserQuestion` question. */
export interface DecisionOption {
  label: string;
  description: string;
}
/** What the person answered: the option label(s) picked, plus free text for "Type something." */
export interface DecisionAnswer {
  labels: string[];
  text?: string;
}

/**
 * A past `choice` question and how it was answered from the chat, remembered to suggest the same
 * answer to a similar future question (spec 2026-09-26 §3). `project_name` is joined in for display;
 * it is null for an account-wide decision or an orphaned project.
 */
export interface ChatDecision {
  id: string;
  user_id: string;
  project_id: string | null;
  project_name: string | null;
  conversation_id: string | null;
  tab_question_id: string | null;
  question_index: number;
  header: string;
  question: string;
  options: DecisionOption[];
  multi_select: boolean;
  answer: DecisionAnswer;
  embed_model: string | null;
  suggested_count: number;
  accepted_count: number;
  created_at: string;
}

export interface NewDecision {
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  tab_question_id: string | null;
  question_index: number;
  header: string;
  question: string;
  options: DecisionOption[];
  multi_select: boolean;
  answer: DecisionAnswer;
}

export interface DecisionNeighbour extends ChatDecision {
  similarity: number;
}

/** A `tab_questions` row the sweeper still owes a decision (spec §5): only ever a `choice`, `answered`. */
export interface AnsweredChoiceRow {
  id: string;
  project_id: string;
  conversation_id: string;
  answered_by: string;
  payload: unknown;
  answer: unknown;
}

/** Row shape shared by the raw queries below: every `chat_decisions` column but `embedding` itself
 *  (never selected — it is write-only from here, and never logged), plus the project name join. */
interface RawRow {
  id: string;
  user_id: string;
  project_id: string | null;
  project_name: string | null;
  conversation_id: string | null;
  tab_question_id: string | null;
  question_index: number;
  header: string;
  question: string;
  options: unknown;
  multi_select: boolean;
  answer: unknown;
  embed_model: string | null;
  suggested_count: number;
  accepted_count: number;
  created_at: Date;
}

const DECISION_COLUMNS = Prisma.raw(
  `id, user_id, project_id, conversation_id, tab_question_id, question_index, header, question, options, multi_select, answer, embed_model, suggested_count, accepted_count, created_at`,
);

/** pgvector's text input format: `[x,y,z]`. Never-finite components (NaN, Infinity) are zeroed rather
 *  than sent malformed, since a bad embedding would otherwise fail the whole write. */
const toVector = (v: number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

const mapRaw = (r: RawRow): ChatDecision => ({
  id: r.id,
  user_id: r.user_id,
  project_id: r.project_id,
  project_name: r.project_name,
  conversation_id: r.conversation_id,
  tab_question_id: r.tab_question_id,
  question_index: r.question_index,
  header: r.header,
  question: r.question,
  options: r.options as DecisionOption[],
  multi_select: r.multi_select,
  answer: r.answer as DecisionAnswer,
  embed_model: r.embed_model,
  suggested_count: r.suggested_count,
  accepted_count: r.accepted_count,
  created_at: r.created_at.toISOString(),
});

/** Escapes a person's search text for a LIKE/ILIKE pattern: `%`/`_` are wildcards and `\` is the
 *  escape character itself, so all three must be escaped before wrapping in `%…%`. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Keyset cursor over `(created_at, id)`, newest first: opaque to the caller, defensively decoded — an
 *  old, foreign or tampered cursor is treated as "no cursor" (first page) rather than an error. */
const encodeCursor = (createdAt: Date, id: string): string => Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
const decodeCursor = (cursor: string): { createdAt: Date; id: string } | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    const createdAt = new Date(parsed[0]);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed[1] };
  } catch {
    return null;
  }
};

/**
 * Chat decision memory (spec 2026-09-26): the `choice` questions a person already answered from the
 * chat, embedded for similarity search (pgvector, raw SQL throughout — `embedding` is an
 * `Unsupported` Prisma type) so a near-identical future question can suggest the same answer.
 */
export class ChatDecisionsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * One row per question of an answered `AskUserQuestion` payload (a payload can hold up to 4). The
   * unique `(tab_question_id, question_index)` index makes recording idempotent: replaying the same
   * tab question's decisions (the backfill sweep, a retried write) inserts nothing the second time and
   * returns `[]` for it, never a duplicate row.
   */
  async insertMany(rows: NewDecision[]): Promise<ChatDecision[]> {
    if (rows.length === 0) return [];
    return this.db.$transaction(async (tx) => {
      const out: ChatDecision[] = [];
      for (const r of rows) {
        const [row] = await tx.$queryRaw<RawRow[]>`
          WITH ins AS (
            INSERT INTO "chat_decisions" ("id", "user_id", "project_id", "conversation_id", "tab_question_id", "question_index", "header", "question", "options", "multi_select", "answer")
            VALUES (${newId()}, ${r.user_id}, ${r.project_id}, ${r.conversation_id}, ${r.tab_question_id}, ${r.question_index}, ${r.header}, ${r.question}, ${JSON.stringify(r.options)}::jsonb, ${r.multi_select}, ${JSON.stringify(r.answer)}::jsonb)
            ON CONFLICT ("tab_question_id", "question_index") WHERE "tab_question_id" IS NOT NULL DO NOTHING
            RETURNING ${DECISION_COLUMNS}
          )
          SELECT ins.*, p.name AS project_name FROM ins LEFT JOIN "projects" p ON p.id = ins.project_id`;
        if (row) out.push(mapRaw(row));
      }
      return out;
    });
  }

  async setEmbedding(id: string, vector: number[], model: string): Promise<void> {
    const v = toVector(vector);
    await this.db.$executeRaw`UPDATE "chat_decisions" SET "embedding" = ${v}::vector, "embed_model" = ${model} WHERE "id" = ${id}`;
  }

  /** Not yet embedded (the sweeper's backlog), oldest first — `embedding` is `Unsupported` in Prisma,
   *  so this and every other read that touches it goes through raw SQL. */
  async listToEmbed(limit: number): Promise<Pick<ChatDecision, 'id' | 'header' | 'question' | 'options'>[]> {
    const rows = await this.db.$queryRaw<{ id: string; header: string; question: string; options: unknown }[]>`
      SELECT id, header, question, options FROM "chat_decisions" WHERE embedding IS NULL ORDER BY created_at ASC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, header: r.header, question: r.question, options: r.options as DecisionOption[] }));
  }

  /** The `k` nearest decisions of this user, same `multi_select` shape, best (highest cosine similarity)
   *  first. Never another user's rows, never the other `multi_select` shape, never an unembedded row. */
  async nearest(userId: string, vector: number[], opts: { multiSelect: boolean; k: number }): Promise<DecisionNeighbour[]> {
    const v = toVector(vector);
    const rows = await this.db.$queryRaw<(RawRow & { similarity: number | string })[]>`
      SELECT d.id, d.user_id, d.project_id, p.name AS project_name, d.conversation_id, d.tab_question_id, d.question_index,
             d.header, d.question, d.options, d.multi_select, d.answer, d.embed_model, d.suggested_count, d.accepted_count, d.created_at,
             1 - (d.embedding <=> ${v}::vector) AS similarity
      FROM "chat_decisions" d LEFT JOIN "projects" p ON p.id = d.project_id
      WHERE d.user_id = ${userId} AND d.embedding IS NOT NULL AND d.multi_select = ${opts.multiSelect}
      ORDER BY d.embedding <=> ${v}::vector
      LIMIT ${opts.k}`;
    return rows.map((r) => ({ ...mapRaw(r), similarity: Number(r.similarity) }));
  }

  async bumpSuggested(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.chatDecision.updateMany({ where: { id: { in: ids } }, data: { suggestedCount: { increment: 1 } } });
  }

  async bumpAccepted(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.chatDecision.updateMany({ where: { id: { in: ids } }, data: { acceptedCount: { increment: 1 } } });
  }

  /** Newest first, for the "Memória do chat" list: `q` searches header, question and answer text
   *  (case-insensitive, substring), and the cursor is a keyset over `(created_at, id)`. */
  async listForUser(userId: string, opts: { q?: string; cursor?: string; limit: number }): Promise<{ items: ChatDecision[]; next_cursor: string | null }> {
    const q = opts.q?.trim();
    const like = q ? `%${escapeLike(q)}%` : null;
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const rows = await this.db.$queryRaw<RawRow[]>`
      SELECT d.id, d.user_id, d.project_id, p.name AS project_name, d.conversation_id, d.tab_question_id, d.question_index,
             d.header, d.question, d.options, d.multi_select, d.answer, d.embed_model, d.suggested_count, d.accepted_count, d.created_at
      FROM "chat_decisions" d LEFT JOIN "projects" p ON p.id = d.project_id
      WHERE d.user_id = ${userId}
        AND (${like}::text IS NULL OR d.header ILIKE ${like} ESCAPE '\\' OR d.question ILIKE ${like} ESCAPE '\\' OR d.answer::text ILIKE ${like} ESCAPE '\\')
        AND (${cur === null}::boolean OR (d.created_at, d.id) < (${cur?.createdAt ?? new Date(0)}, ${cur?.id ?? ''}))
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${opts.limit + 1}`;
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const next_cursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
    return { items: page.map(mapRaw), next_cursor };
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const { count } = await this.db.chatDecision.deleteMany({ where: { id, userId } });
    return count > 0;
  }

  countForUser(userId: string): Promise<number> {
    return this.db.chatDecision.count({ where: { userId } });
  }

  /** A `choice` question the chat answered but the sweeper has not yet turned into decisions (spec §5):
   *  never a `permission` row, and never one still `open` (only `answered` questions are remembered). */
  async listAnsweredChoicesWithoutDecision(limit: number): Promise<AnsweredChoiceRow[]> {
    return this.db.$queryRaw<AnsweredChoiceRow[]>`
      SELECT q.id, q.project_id, q.conversation_id, q.answered_by, q.payload, q.answer
      FROM "tab_questions" q
      WHERE q.kind = 'choice' AND q.status = 'answered' AND q.answered_by IS NOT NULL AND q.answer IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "chat_decisions" d WHERE d.tab_question_id = q.id)
      ORDER BY q.answered_at ASC LIMIT ${limit}`;
  }
}
