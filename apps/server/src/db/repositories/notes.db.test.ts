import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { renderLessonBlock } from '../../lessons/note.js';
import { NOTE_MAX, NoteTooLargeError, NotesRepository } from './notes.js';

// Real timestamps (never a fixed literal): mergeNoteSave compares a block's `at` against a `base_updated_at`
// snapshot taken from the actual DB clock, so a block must be rendered with the real "now" to land after it.
const at = () => new Date();
const lessonInput = { symptom: 'P3009', cause: 'migração quebrou', fix: 'resolve --rolled-back', evidence: 'fixed' as const };

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see tasks.db.test.ts / README).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('NotesRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: NotesRepository;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new NotesRepository(db);
  });

  beforeEach(async () => {
    projectId = newId();
    await db.project.create({ data: { id: projectId, key: 'K' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
    return async () => {
      await db.project.delete({ where: { id: projectId } }); // cascades the note
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('appendBlock creates the note when the project has none yet', async () => {
    const block = renderLessonBlock('l1', at(), null, lessonInput);
    const note = await repo.appendBlock(projectId, () => block);
    expect(note.project_id).toBe(projectId);
    expect(note.content).toContain('## Lições');
    expect(note.content).toContain('id=l1');
  });

  it('appendBlock renders the block under the lock: its at is never earlier than the note\'s updated_at', async () => {
    // A person's save that committed with a clock slightly ahead (or just after this call started):
    // the row's updated_at is later than any "now" taken before the lock.
    await repo.saveMerged(projectId, 'Meu texto', null);
    const ahead = new Date(Date.now() + 60_000);
    await db.$executeRaw`UPDATE notes SET updated_at = ${ahead} WHERE project_id = ${projectId}`;

    let renderedAt: Date | null = null;
    const note = await repo.appendBlock(projectId, (at) => {
      renderedAt = at;
      return renderLessonBlock('l1', at, null, lessonInput);
    });
    expect(renderedAt).not.toBeNull();
    expect(renderedAt!.getTime()).toBeGreaterThan(ahead.getTime());
    expect(note.content).toContain(`at=${renderedAt!.toISOString()}`);
    // The row's own updated_at is the block's at: a client that loads this note has seen the block.
    expect(note.updated_at).toBe(renderedAt!.toISOString());
    // A save from a client whose base is the pre-append row (it never saw the block) keeps it (D9).
    const merged = await repo.saveMerged(projectId, 'Meu texto editado', ahead);
    expect(merged.content).toContain('id=l1');
  });

  it('keeps both blocks when two appendBlock calls race', async () => {
    const b1 = renderLessonBlock('l1', at(), null, lessonInput);
    const b2 = renderLessonBlock('l2', at(), null, lessonInput);
    await Promise.all([repo.appendBlock(projectId, () => b1), repo.appendBlock(projectId, () => b2)]);
    const note = await repo.getByProject(projectId);
    expect(note.content).toContain('id=l1');
    expect(note.content).toContain('id=l2');
  });

  it('saveMerged keeps a block appended after the base even though the submission drops it', async () => {
    await repo.saveMerged(projectId, 'Meu texto', null);
    const base = await repo.getByProject(projectId);
    await repo.appendBlock(projectId, (a) => renderLessonBlock('new', a, null, lessonInput));
    const merged = await repo.saveMerged(projectId, 'Meu texto editado', new Date(base.updated_at));
    expect(merged.content).toContain('Meu texto editado');
    expect(merged.content).toContain('id=new');
  });

  it('saveMerged with a base after the block\'s at drops the block the person deleted', async () => {
    await repo.appendBlock(projectId, (a) => renderLessonBlock('old', a, null, lessonInput));
    const afterAppend = await repo.getByProject(projectId);
    const base = new Date(new Date(afterAppend.updated_at).getTime() + 1000);
    const merged = await repo.saveMerged(projectId, 'Meu texto', base);
    expect(merged.content).not.toContain('id=old');
  });

  it('saveMerged with base=null is a plain upsert (old clients)', async () => {
    const note = await repo.saveMerged(projectId, 'texto simples', null);
    expect(note.content).toBe('texto simples');
  });

  it('removeBlock removes one block by id', async () => {
    await repo.appendBlock(projectId, (a) => renderLessonBlock('l1', a, null, lessonInput));
    await repo.appendBlock(projectId, (a) => renderLessonBlock('l2', a, null, lessonInput));
    const note = await repo.removeBlock(projectId, 'l1');
    expect(note!.content).not.toContain('id=l1');
    expect(note!.content).toContain('id=l2');
  });

  it('removeBlock is null when the project has no note (nothing to remove from)', async () => {
    expect(await repo.removeBlock(projectId, 'nope')).toBeNull();
  });

  it('appendBlock throws NoteTooLargeError past NOTE_MAX', async () => {
    await repo.saveMerged(projectId, 'x'.repeat(NOTE_MAX - 10), null);
    const bigBlock = renderLessonBlock('big', at(), null, { ...lessonInput, symptom: 'y'.repeat(100) });
    await expect(repo.appendBlock(projectId, () => bigBlock)).rejects.toBeInstanceOf(NoteTooLargeError);
  });

  it('saveMerged throws NoteTooLargeError when the merge pushes the result over NOTE_MAX', async () => {
    await repo.appendBlock(projectId, (a) => renderLessonBlock('l1', a, null, lessonInput));
    const base = await repo.getByProject(projectId);
    const oversized = 'x'.repeat(NOTE_MAX + 1);
    await expect(repo.saveMerged(projectId, oversized, new Date(base.updated_at))).rejects.toBeInstanceOf(NoteTooLargeError);
  });
});
