import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { appendLessonBlock, mergeNoteSave, removeLessonBlock } from '../../lessons/note.js';
import { mapNote, type Note } from './types.js';

/** Same limit the route's zod schema enforces on `content` — re-checked here because an append or a
 *  merge can push an already-valid note past it (spec 2026-09-27 failure lessons D9/§9). */
export const NOTE_MAX = 200_000;

/** A lesson append or a merged save would leave the note over NOTE_MAX. The route maps this to 413. */
export class NoteTooLargeError extends Error {
  constructor() {
    super('note too large');
  }
}

type Row = { id: string; content: string };

/**
 * Creates the note row empty if the project has none yet, then locks it — the pair `appendBlock` and
 * `saveMerged` (with a base) both need before touching content (spec D9). The insert has to come
 * *before* the lock: a project's very first note has no row yet, so `SELECT … FOR UPDATE` alone would
 * find nothing to lock, and two first-ever writers racing each other must not both try to create the
 * row — `ON CONFLICT (project_id) DO NOTHING` makes the loser's insert a no-op instead of an error, so
 * both then reach the same row through the `SELECT … FOR UPDATE` that follows, one waiting for the
 * other's transaction to commit.
 */
async function lockOrCreate(tx: Prisma.TransactionClient, projectId: string): Promise<Row> {
  await tx.$executeRaw`INSERT INTO notes (id, project_id, content, updated_at) VALUES (${newId()}, ${projectId}, '', now()) ON CONFLICT (project_id) DO NOTHING`;
  const [row] = await tx.$queryRaw<Row[]>`SELECT id, content FROM notes WHERE project_id = ${projectId} FOR UPDATE`;
  return row!;
}

export class NotesRepository {
  constructor(private db: PrismaClient) {}

  async getByProject(projectId: string): Promise<Note> {
    const n = await this.db.note.findUnique({ where: { projectId } });
    if (n) return mapNote(n);
    return { id: '', project_id: projectId, content: '', updated_at: new Date(0).toISOString() };
  }

  /** Plain replace, no lock: what every caller used before locked lesson append existed, and still what
   *  `saveMerged` does for an old client that never sends `base_updated_at`. */
  async upsert(projectId: string, content: string): Promise<Note> {
    const n = await this.db.note.upsert({
      where: { projectId },
      create: { id: newId(), projectId, content },
      update: { content },
    });
    return mapNote(n);
  }

  /**
   * Appends a fenced lesson block under the project note, row-locked (spec D9): the note is created
   * empty first if the project has none yet (`ON CONFLICT … DO NOTHING`, so two concurrent first-appends
   * never race each other to create it), then the row is taken with `SELECT … FOR UPDATE` before the
   * append is computed — a second `appendBlock` racing this one waits for the transaction to commit and
   * reads the block this one just wrote, so both blocks land instead of one clobbering the other.
   */
  async appendBlock(projectId: string, block: string): Promise<Note> {
    return this.db.$transaction(async (tx) => {
      const row = await lockOrCreate(tx, projectId);
      const content = appendLessonBlock(row.content, block);
      if (content.length > NOTE_MAX) throw new NoteTooLargeError();
      return mapNote(await tx.note.update({ where: { id: row.id }, data: { content } }));
    });
  }

  /**
   * Removes one lesson block by id ("Esquecer", spec §6), locked the same way as `appendBlock` so it
   * cannot race a concurrent append. A project with no note yet has nothing to remove from: null, like
   * a row that does not exist — `removeLessonBlock` itself is a no-op for an id it cannot find, but that
   * still needs a row to read and write back.
   */
  async removeBlock(projectId: string, lessonId: string): Promise<Note | null> {
    return this.db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Row[]>`SELECT id, content FROM notes WHERE project_id = ${projectId} FOR UPDATE`;
      if (!row) return null;
      const content = removeLessonBlock(row.content, lessonId);
      return mapNote(await tx.note.update({ where: { id: row.id }, data: { content } }));
    });
  }

  /**
   * Saves the person's edit merged with whatever an agent appended concurrently (spec D9). `baseUpdatedAt`
   * null means an old client that never sends it: a plain `upsert`, exactly like before this feature
   * existed. Otherwise the row is created empty if missing and locked, `mergeNoteSave` reconciles the
   * submission against what is actually in the database (a block newer than the base the submission
   * dropped is kept; one older than the base and missing was deleted on purpose), and NOTE_MAX is
   * re-checked on the merged result — a merge can push an already-valid submission back over the limit.
   */
  async saveMerged(projectId: string, content: string, baseUpdatedAt: Date | null): Promise<Note> {
    if (baseUpdatedAt === null) {
      if (content.length > NOTE_MAX) throw new NoteTooLargeError();
      return this.upsert(projectId, content);
    }
    return this.db.$transaction(async (tx) => {
      const row = await lockOrCreate(tx, projectId);
      const merged = mergeNoteSave(row.content, content, baseUpdatedAt);
      if (merged.length > NOTE_MAX) throw new NoteTooLargeError();
      return mapNote(await tx.note.update({ where: { id: row.id }, data: { content: merged } }));
    });
  }
}
