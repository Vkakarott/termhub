import { createHash } from 'node:crypto';
import type { PrismaClient } from '../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type MemoryKind = 'task' | 'message' | 'action' | 'doc' | 'note';
export type MemoryTrust = 'person' | 'derived';

/**
 * One chunk of the concierge's searchable memory (spec 2026-09-26 concierge memory §3.1): a card, a
 * message the person typed, a gate decision, a spec/plan section or a note. Decisions answered on a
 * card live in `chat_decisions` (see `ChatDecisionsRepository`), not here. `project_name` is joined in
 * for display; it is null for an account-wide item or an orphaned project.
 */
export interface MemoryItem {
  id: string;
  owner_id: string;
  project_id: string | null;
  project_name: string | null;
  kind: MemoryKind;
  source_id: string;
  chunk_index: number;
  title: string;
  text: string;
  trust: MemoryTrust;
  content_hash: string;
  source_hash: string | null;
  embed_model: string | null;
  source_at: string;
  created_at: string;
  updated_at: string;
}

export interface NewMemoryItem {
  owner_id: string;
  project_id: string | null;
  kind: MemoryKind;
  source_id: string;
  chunk_index: number;
  title: string;
  text: string;
  trust: MemoryTrust;
  source_at: Date;
  /** the whole source's hash (a doc file's sha256), so the docs sweeper can skip unchanged files; null otherwise */
  source_hash?: string | null;
}

export interface MemoryHit extends MemoryItem {
  similarity: number | null;
  rank: number;
}

export interface MemoryFilter {
  ownerId: string;
  projectId?: string;
  kinds?: MemoryKind[];
}

/** Row shape shared by the raw queries below: every `memory_items` column but `embedding` itself
 *  (never selected — it is write-only from here, and never logged), plus the project name join. */
interface RawItem {
  id: string;
  owner_id: string;
  project_id: string | null;
  project_name: string | null;
  kind: string;
  source_id: string;
  chunk_index: number;
  title: string;
  text: string;
  trust: string;
  content_hash: string;
  source_hash: string | null;
  embed_model: string | null;
  source_at: Date;
  created_at: Date;
  updated_at: Date;
}

const ITEM_COLUMNS = Prisma.raw(
  `m.id, m.owner_id, m.project_id, m.kind, m.source_id, m.chunk_index, m.title, m.text, m.trust, m.content_hash, m.source_hash, m.embed_model, m.source_at, m.created_at, m.updated_at`,
);

/** pgvector's text input format: `[x,y,z]`. Never-finite components (NaN, Infinity) are zeroed rather
 *  than sent malformed, since a bad embedding would otherwise fail the whole write. */
const toVector = (v: number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

/** `sha256(title + '\n' + text)`: re-embed only when the chunk's content actually changed. */
const contentHash = (title: string, text: string): string => createHash('sha256').update(`${title}\n${text}`).digest('hex');

const mapRaw = (r: RawItem): MemoryItem => ({
  id: r.id,
  owner_id: r.owner_id,
  project_id: r.project_id,
  project_name: r.project_name,
  kind: r.kind as MemoryKind,
  source_id: r.source_id,
  chunk_index: r.chunk_index,
  title: r.title,
  text: r.text,
  trust: r.trust as MemoryTrust,
  content_hash: r.content_hash,
  source_hash: r.source_hash,
  embed_model: r.embed_model,
  source_at: r.source_at.toISOString(),
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
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
 * Concierge memory (spec 2026-09-26 concierge memory): free-text chunks from cards, the person's chat
 * messages, gate decisions, project specs/plans and notes, embedded for similarity search alongside
 * full-text (raw SQL throughout — `embedding` is an `Unsupported` Prisma type).
 */
export class MemoryItemsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * Insert or update on `(kind, source_id, chunk_index)`. An unchanged `content_hash` keeps the
   * embedding (the writer re-sent the same text); a changed one clears it, so the sweeper picks the
   * row up again. Returns only the rows whose embedding is now null — the ones the sweeper still owes
   * an embedding, never the ones that kept theirs.
   */
  async upsertMany(items: NewMemoryItem[]): Promise<MemoryItem[]> {
    if (items.length === 0) return [];
    return this.db.$transaction(async (tx) => {
      const out: MemoryItem[] = [];
      for (const it of items) {
        const hash = contentHash(it.title, it.text);
        const [row] = await tx.$queryRaw<(RawItem & { needs_embedding: boolean })[]>`
          INSERT INTO "memory_items" ("id","owner_id","project_id","kind","source_id","chunk_index","title","text","trust","content_hash","source_hash","source_at","updated_at")
          VALUES (${newId()}, ${it.owner_id}, ${it.project_id}, ${it.kind}, ${it.source_id}, ${it.chunk_index}, ${it.title}, ${it.text}, ${it.trust}, ${hash}, ${it.source_hash ?? null}, ${it.source_at}, now())
          ON CONFLICT ("kind","source_id","chunk_index") DO UPDATE SET
            "title" = EXCLUDED."title", "text" = EXCLUDED."text", "trust" = EXCLUDED."trust", "project_id" = EXCLUDED."project_id",
            "source_at" = EXCLUDED."source_at", "updated_at" = now(), "content_hash" = EXCLUDED."content_hash", "source_hash" = EXCLUDED."source_hash",
            "embedding" = CASE WHEN "memory_items"."content_hash" = EXCLUDED."content_hash" THEN "memory_items"."embedding" ELSE NULL END,
            "embed_model" = CASE WHEN "memory_items"."content_hash" = EXCLUDED."content_hash" THEN "memory_items"."embed_model" ELSE NULL END
          RETURNING id, owner_id, project_id, (SELECT name FROM "projects" WHERE id = "project_id") AS project_name,
                    kind, source_id, chunk_index, title, text, trust, content_hash, source_hash, embed_model, source_at, created_at, updated_at,
                    (embedding IS NULL) AS needs_embedding`;
        if (row!.needs_embedding) out.push(mapRaw(row!));
      }
      return out;
    });
  }

  /** Removes chunks `fromIndex..` of a source (a doc re-chunked shorter): never chunk 0.. of a
   *  different source, never a lower chunk index. */
  async deleteChunksFrom(kind: MemoryKind, sourceId: string, fromIndex: number): Promise<number> {
    return this.db.$executeRaw`DELETE FROM "memory_items" WHERE "kind" = ${kind} AND "source_id" = ${sourceId} AND "chunk_index" >= ${fromIndex}`;
  }

  /** Every chunk of these sources (a task/doc/etc. that is gone). */
  async deleteBySource(kind: MemoryKind, sourceIds: string[]): Promise<number> {
    if (sourceIds.length === 0) return 0;
    return this.db.$executeRaw`DELETE FROM "memory_items" WHERE "kind" = ${kind} AND "source_id" IN (${Prisma.join(sourceIds)})`;
  }

  /** `source_id → source_hash` of chunk 0, for sources under this prefix (a project link's `<id>:`),
   *  so a docs sweep can skip a file whose hash did not change. Only rows with a non-null hash. */
  async listSourceHashes(kind: MemoryKind, sourceIdPrefix: string): Promise<Map<string, string>> {
    const like = `${escapeLike(sourceIdPrefix)}%`;
    const rows = await this.db.$queryRaw<{ source_id: string; source_hash: string }[]>`
      SELECT "source_id", "source_hash" FROM "memory_items"
      WHERE "kind" = ${kind} AND "chunk_index" = 0 AND "source_hash" IS NOT NULL AND "source_id" LIKE ${like} ESCAPE '\\'`;
    return new Map(rows.map((r) => [r.source_id, r.source_hash]));
  }

  /** `source_id → source_at`, for the card sweeper: only re-chunk a task whose `updated_at` is newer. */
  async listSourceAt(kind: 'task', ownerId: string): Promise<Map<string, string>> {
    const rows = await this.db.$queryRaw<{ source_id: string; source_at: Date }[]>`
      SELECT "source_id", "source_at" FROM "memory_items" WHERE "kind" = ${kind} AND "owner_id" = ${ownerId}`;
    return new Map(rows.map((r) => [r.source_id, r.source_at.toISOString()]));
  }

  async setEmbedding(id: string, vector: number[], model: string): Promise<void> {
    const v = toVector(vector);
    await this.db.$executeRaw`UPDATE "memory_items" SET "embedding" = ${v}::vector, "embed_model" = ${model} WHERE "id" = ${id}`;
  }

  /** Not yet embedded (the sweeper's backlog), oldest first. */
  async listToEmbed(limit: number): Promise<Pick<MemoryItem, 'id' | 'title' | 'text'>[]> {
    return this.db.$queryRaw<{ id: string; title: string; text: string }[]>`
      SELECT "id", "title", "text" FROM "memory_items" WHERE "embedding" IS NULL ORDER BY "created_at" ASC LIMIT ${limit}`;
  }

  /**
   * The `k` nearest items of this owner, best (highest cosine similarity) first: an exact scan, no ANN
   * index (spec D5) — never another owner's rows, never an unembedded row, `projectId`/`kinds` narrow
   * further when given. `rank` is the 1-based position in this result.
   */
  async nearest(filter: MemoryFilter, vector: number[], k: number): Promise<MemoryHit[]> {
    const v = toVector(vector);
    const rows = await this.db.$queryRaw<(RawItem & { similarity: number | string })[]>`
      SELECT ${ITEM_COLUMNS}, p.name AS project_name,
             1 - (m.embedding <=> ${v}::vector) AS similarity
      FROM "memory_items" m LEFT JOIN "projects" p ON p.id = m.project_id
      WHERE m.owner_id = ${filter.ownerId} AND m.embedding IS NOT NULL
        AND (${filter.projectId ?? null}::text IS NULL OR m.project_id = ${filter.projectId ?? null})
        AND (${filter.kinds ?? null}::text[] IS NULL OR m.kind = ANY(${filter.kinds ?? null}::text[]))
      ORDER BY m.embedding <=> ${v}::vector
      LIMIT ${k}`;
    return rows.map((r, i) => ({ ...mapRaw(r), similarity: Number(r.similarity), rank: i + 1 }));
  }

  /** Postgres full-text over `title || ' ' || text` (D5: no tsvector index, one owner's rows are few),
   *  best `ts_rank` first. A query with no lexeme (only punctuation) matches nothing rather than
   *  throwing or matching everything — `numnode(tsq) > 0` guards it. */
  async textSearch(filter: MemoryFilter, query: string, k: number): Promise<MemoryHit[]> {
    const rows = await this.db.$queryRaw<RawItem[]>`
      WITH q AS (SELECT websearch_to_tsquery('simple', ${query}) AS tsq)
      SELECT ${ITEM_COLUMNS}, p.name AS project_name
      FROM "memory_items" m CROSS JOIN q LEFT JOIN "projects" p ON p.id = m.project_id
      WHERE m.owner_id = ${filter.ownerId}
        AND (${filter.projectId ?? null}::text IS NULL OR m.project_id = ${filter.projectId ?? null})
        AND (${filter.kinds ?? null}::text[] IS NULL OR m.kind = ANY(${filter.kinds ?? null}::text[]))
        AND numnode(q.tsq) > 0
        AND to_tsvector('simple', m.title || ' ' || m.text) @@ q.tsq
      ORDER BY ts_rank(to_tsvector('simple', m.title || ' ' || m.text), q.tsq) DESC, m.source_at DESC
      LIMIT ${k}`;
    return rows.map((r, i) => ({ ...mapRaw(r), similarity: null, rank: i + 1 }));
  }

  async findManyForOwner(ids: string[], ownerId: string): Promise<MemoryItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.$queryRaw<RawItem[]>`
      SELECT ${ITEM_COLUMNS}, p.name AS project_name
      FROM "memory_items" m LEFT JOIN "projects" p ON p.id = m.project_id
      WHERE m.owner_id = ${ownerId} AND m.id IN (${Prisma.join(ids)})`;
    return rows.map(mapRaw);
  }

  countNotesSince(ownerId: string, since: Date): Promise<number> {
    return this.db.memoryItem.count({ where: { ownerId, kind: 'note', createdAt: { gte: since } } });
  }

  /** "Anotações do concierge" (spec D12): newest first, keyset cursor over `(created_at, id)`. */
  async listNotes(ownerId: string, opts: { cursor?: string; limit: number }): Promise<{ items: MemoryItem[]; next_cursor: string | null }> {
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const rows = await this.db.$queryRaw<RawItem[]>`
      SELECT ${ITEM_COLUMNS}, p.name AS project_name
      FROM "memory_items" m LEFT JOIN "projects" p ON p.id = m.project_id
      WHERE m.owner_id = ${ownerId} AND m.kind = 'note'
        AND (${cur === null}::boolean OR (m.created_at, m.id) < (${cur?.createdAt ?? new Date(0)}, ${cur?.id ?? ''}))
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${opts.limit + 1}`;
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const next_cursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
    return { items: page.map(mapRaw), next_cursor };
  }

  /** "Esquecer": only the owner's own note, never a card/message/action/doc chunk. */
  async deleteNote(id: string, ownerId: string): Promise<boolean> {
    const { count } = await this.db.memoryItem.deleteMany({ where: { id, ownerId, kind: 'note' } });
    return count > 0;
  }
}
