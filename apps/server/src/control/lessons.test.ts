import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { MemoryItem } from '../db/repositories/memory-items.js';
import { NoteTooLargeError } from '../db/repositories/notes.js';
import type { Project, Tab } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import { HttpError } from '../lib/errors.js';
import { ControlError, type ControlContext } from './context.js';
import { LESSONS_PER_HOUR, recordLesson } from './lessons.js';

const indexProjectNote = vi.hoisted(() => vi.fn(async () => ({ sections: 0, lessons: 1 })));
vi.mock('../memory/note.js', () => ({ indexProjectNote }));

const project = (over: Partial<Project> & { id: string }): Project => ({
  owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});

const tab = (over: Partial<Tab> & { id: string; project_id: string; machine_id: string }): Tab => ({ name: over.id, ...over }) as unknown as Tab;

const item = (over: Partial<MemoryItem> & { id: string; source_id: string }): MemoryItem => ({
  owner_id: 'u1', project_id: 'p1', project_name: 'p1', kind: 'lesson', chunk_index: 0, title: 't', text: 'x', trust: 'derived',
  content_hash: 'h', source_hash: null, embed_model: null, meta: null, verified: false, verified_at: null,
  source_at: '2026-09-27T00:00:00.000Z', created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z', ...over,
});

interface Setup {
  count?: number;
  appendBlock?: () => Promise<unknown>;
  lessons?: MemoryItem[];
  user?: string;
}

function ctxFor(setup: Setup = {}) {
  const projects = [project({ id: 'p1' }), project({ id: 'p2' }), project({ id: 'px', owner_id: 'u2' })];
  const machines = [{ id: 'm1', owner_id: 'u1' }];
  const links = [
    { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/src', position: 0, created_at: '' },
    { id: 'l2', project_id: 'p2', machine_id: 'm1', cwd: '/src', position: 0, created_at: '' },
  ];
  const tabs = [tab({ id: 't1', project_id: 'p1', machine_id: 'm1' }), tab({ id: 't2', project_id: 'p2', machine_id: 'm1' })];
  const countNoteLessonsSince = vi.fn(async () => setup.count ?? 0);
  const appendBlock = vi.fn(setup.appendBlock ?? (async () => ({ id: 'n1', project_id: 'p1', content: '', updated_at: '2026-09-27T00:00:00.000Z' })));
  const listLessons = vi.fn(async () => ({ items: setup.lessons ?? [], next_cursor: null }));
  const repos = {
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    tabs: { findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)) },
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)) },
    projectMachines: { find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)) },
    notes: { appendBlock },
    memoryItems: { countNoteLessonsSince, listLessons },
  };
  const user = setup.user ?? 'u1';
  const scope = { user: { id: user } as never, viewAs: { kind: 'self' as const }, ownerId: user, createAs: user };
  const ctx: ControlContext = { repos: repos as unknown as Repositories, scope, scoped: new Scoped(repos as unknown as Repositories, scope), can: async () => true };
  return { ctx, repos, calls: { countNoteLessonsSince, appendBlock, listLessons } };
}

const validInput = { project_id: 'p1', symptom: 'P3009: migrate found failed migrations', cause: 'a migração anterior falhou', fix: 'rodar resolve --applied' };

describe('recordLesson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks project_id through ctx.scoped.project: a foreign project 404s with nothing written', async () => {
    const { ctx, calls } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, project_id: 'px' }, { embedder: null, log: console })).rejects.toBeInstanceOf(HttpError);
    expect(calls.appendBlock).not.toHaveBeenCalled();
  });

  it('checks project_id through ctx.scoped.project: a missing project also 404s', async () => {
    const { ctx } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, project_id: 'nope' }, { embedder: null, log: console })).rejects.toBeInstanceOf(HttpError);
  });

  it('a missing tab_id 404s with nothing written', async () => {
    const { ctx, calls } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, tab_id: 'nope' }, { embedder: null, log: console })).rejects.toBeInstanceOf(HttpError);
    expect(calls.appendBlock).not.toHaveBeenCalled();
  });

  it('a tab_id from another project is refused with TAB_OTHER_PROJECT, nothing written', async () => {
    const { ctx, calls } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, project_id: 'p1', tab_id: 't2' }, { embedder: null, log: console })).rejects.toMatchObject({ code: 'TAB_OTHER_PROJECT' });
    expect(calls.appendBlock).not.toHaveBeenCalled();
  });

  it('accepts a tab_id that belongs to the project', async () => {
    const { ctx, calls } = ctxFor({ lessons: [item({ id: 'm1', source_id: 'note:p1:abc' })] });
    await recordLesson(ctx, { ...validInput, project_id: 'p1', tab_id: 't1' }, { embedder: null, log: console });
    expect(calls.appendBlock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['symptom', { symptom: 'leaked thb_pat_abcdefgh12345678' }],
    ['cause', { cause: 'a chave sk-abcdefghijklmnop foi commitada' }],
    ['fix', { fix: 'revogar ghp_' + 'a'.repeat(36) }],
    ['card', { card: 'AKIAABCDEFGHIJKLMNOP' }],
    ['pr', { pr: 'https://example.com/AKIAABCDEFGHIJKLMNOP' }],
  ])('a secret in %s is refused with LESSON_SECRET, nothing written', async (_field, over) => {
    const { ctx, calls } = ctxFor();
    await expect(recordLesson(ctx, { ...validInput, ...over }, { embedder: null, log: console })).rejects.toMatchObject({ code: 'LESSON_SECRET' });
    expect(calls.appendBlock).not.toHaveBeenCalled();
    expect(indexProjectNote).not.toHaveBeenCalled();
  });

  it('refuses the 21st lesson within an hour, and writes nothing', async () => {
    const { ctx, calls } = ctxFor({ count: LESSONS_PER_HOUR });
    await expect(recordLesson(ctx, validInput, { embedder: null, log: console })).rejects.toMatchObject({ code: 'LESSONS_RATE_LIMITED' });
    expect(calls.appendBlock).not.toHaveBeenCalled();
  });

  it('allows the 20th lesson in the hour', async () => {
    const { ctx, calls } = ctxFor({ count: LESSONS_PER_HOUR - 1, lessons: [item({ id: 'm1', source_id: 'note:p1:abc' })] });
    await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(calls.appendBlock).toHaveBeenCalledTimes(1);
  });

  it('a full note is refused as NOTE_FULL, and the rate limit was already checked', async () => {
    const { ctx, calls } = ctxFor({ appendBlock: async () => { throw new NoteTooLargeError(); } });
    await expect(recordLesson(ctx, validInput, { embedder: null, log: console })).rejects.toMatchObject({ code: 'NOTE_FULL' });
    expect(calls.countNoteLessonsSince).toHaveBeenCalled();
  });

  it('on success appends the block, indexes the note and resolves the ref of the freshly indexed item', async () => {
    const { ctx, calls } = ctxFor();
    // The lesson id is generated inside recordLesson, so the lookup mock reads it back out of the
    // block just appended (mirroring how the real note indexer keys a lesson item by the fence's own id).
    let writtenBlock = '';
    calls.appendBlock.mockImplementationOnce(async (_projectId: string, block: string) => {
      writtenBlock = block;
      return { id: 'n1', project_id: 'p1', content: block, updated_at: '2026-09-27T00:00:00.000Z' };
    });
    calls.listLessons.mockImplementation(async (_owner: string, o: { projectId?: string }) => {
      const m = /id=([a-z0-9]+)/.exec(writtenBlock);
      return { items: m ? [item({ id: 'm9', source_id: `note:${o.projectId}:${m[1]}` })] : [], next_cursor: null };
    });

    const r = await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(calls.appendBlock).toHaveBeenCalledTimes(1);
    expect(indexProjectNote).toHaveBeenCalledTimes(1);
    expect(indexProjectNote).toHaveBeenCalledWith(ctx.repos, 'p1', { embedder: null, log: console });
    expect(r.lesson_id).toMatch(/^[a-z0-9]+$/);
    expect(r.ref).toBe('lesson:m9');
  });

  it('succeeds with ref: null when the freshly indexed item cannot be found', async () => {
    const { ctx } = ctxFor({ lessons: [] });
    const r = await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(r.lesson_id).toBeTruthy();
    expect(r.ref).toBeNull();
  });

  it('the generated lesson id matches the note fence format ([a-z0-9_]{1,40})', async () => {
    const { ctx } = ctxFor();
    const r = await recordLesson(ctx, validInput, { embedder: null, log: console });
    expect(r.lesson_id).toMatch(/^[a-z0-9_]{1,40}$/);
  });
});
