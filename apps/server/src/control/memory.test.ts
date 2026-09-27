import { describe, expect, it, vi } from 'vitest';
import type { ChatDecision, DecisionNeighbour } from '../db/repositories/chat-decisions.js';
import type { MemoryFilter, MemoryHit } from '../db/repositories/memory-items.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Project } from '../db/repositories/types.js';
import type { Embedder } from '../chat/embeddings.js';
import { Scoped } from '../auth/scope.js';
import { HttpError } from '../lib/errors.js';
import type { ControlContext } from './context.js';
import { MEMORY_NOTE, MEMORY_REF, parseRef, searchMemory } from './memory.js';

const project = (over: Partial<Project> & { id: string }): Project => ({
  owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});

const decision = (over: Partial<DecisionNeighbour> & { id: string }): DecisionNeighbour => ({
  user_id: 'u1',
  project_id: null,
  project_name: null,
  conversation_id: null,
  tab_question_id: null,
  question_index: 0,
  header: 'Isolamento',
  question: 'Usar git worktree para isolar o trabalho?',
  options: [{ label: 'Sim', description: '' }, { label: 'Não', description: '' }],
  multi_select: false,
  answer: { labels: ['Sim'] },
  embed_model: 'm',
  suggested_count: 0,
  accepted_count: 0,
  auto_count: 0,
  created_at: '2026-09-24T10:00:00.000Z',
  similarity: 0.9,
  ...over,
});

const decisionRanked = (over: Partial<ChatDecision & { rank: number }> & { id: string; rank: number }): ChatDecision & { rank: number } => {
  const { similarity, ...base } = decision(over);
  return { ...base, rank: over.rank };
};

const item = (over: Partial<MemoryHit> & { id: string }): MemoryHit => ({
  owner_id: 'u1',
  project_id: null,
  project_name: null,
  kind: 'note',
  source_id: over.id,
  chunk_index: 0,
  title: 'Anotação',
  text: 'texto da anotação',
  trust: 'derived',
  content_hash: 'h',
  source_hash: null,
  embed_model: 'm',
  source_at: '2026-09-24T10:00:00.000Z',
  created_at: '2026-09-24T10:00:00.000Z',
  updated_at: '2026-09-24T10:00:00.000Z',
  similarity: 0.9,
  rank: 1,
  ...over,
});

interface Setup {
  vecDecisions?: DecisionNeighbour[];
  vecItems?: MemoryHit[];
  textDecisions?: (ChatDecision & { rank: number })[];
  textItems?: MemoryHit[];
  embedder?: Embedder | null;
  user?: string;
}

function ctxFor(setup: Setup = {}) {
  const projects = [project({ id: 'p1' }), project({ id: 'px', owner_id: 'u2' })];
  const nearestAny = vi.fn(async () => setup.vecDecisions ?? []);
  const decisionTextSearch = vi.fn(async () => setup.textDecisions ?? []);
  const nearest = vi.fn(async (_filter: MemoryFilter) => setup.vecItems ?? []);
  const itemTextSearch = vi.fn(async (_filter: MemoryFilter) => setup.textItems ?? []);
  const repos = {
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    chatDecisions: { nearestAny, textSearch: decisionTextSearch },
    memoryItems: { nearest, textSearch: itemTextSearch },
  } as unknown as Repositories;
  const user = setup.user ?? 'u1';
  const scope = { user: { id: user } as never, viewAs: { kind: 'self' as const }, ownerId: user, createAs: user };
  const ctx: ControlContext = { repos, scope, scoped: new Scoped(repos, scope), can: async () => true };
  const embedder: Embedder | null | undefined = 'embedder' in setup ? setup.embedder : { embed: vi.fn(async (texts: string[]) => ({ model: 'm', vectors: texts.map(() => [1, 0, 0]) })) };
  return { ctx, repos, calls: { nearestAny, decisionTextSearch, nearest, itemTextSearch }, embedder };
}

describe('parseRef', () => {
  it('parses a well-formed ref of every kind', () => {
    expect(parseRef('decision:abc123')).toEqual({ kind: 'decision', id: 'abc123' });
    expect(parseRef('doc:abc123')).toEqual({ kind: 'doc', id: 'abc123' });
    expect(parseRef('note:a1b2c3d4e5f6')).toEqual({ kind: 'note', id: 'a1b2c3d4e5f6' });
  });

  it('rejects an unknown kind, uppercase id or missing id', () => {
    expect(parseRef('ticket:abc')).toBeNull();
    expect(parseRef('decision:ABC')).toBeNull();
    expect(parseRef('decision:')).toBeNull();
    expect(parseRef('decision')).toBeNull();
    expect(MEMORY_REF.test('decision:abc123')).toBe(true);
  });
});

describe('searchMemory', () => {
  it('merges vector and text hits by RRF: a key in both lists ranks first with match "both"', async () => {
    const { ctx, embedder } = ctxFor({
      vecDecisions: [decision({ id: 'd1', similarity: 0.95 })],
      vecItems: [item({ id: 'i1', kind: 'doc', similarity: 0.7 })],
      textDecisions: [],
      textItems: [item({ id: 'i1', kind: 'doc', rank: 1 })],
    });
    const r = await searchMemory(ctx, { query: 'worktree' }, { embedder });
    expect(r.note).toBe(MEMORY_NOTE);
    expect(r.results[0]).toMatchObject({ ref: 'doc:i1', match: 'both', similarity: 0.7 });
    expect(r.results[1]).toMatchObject({ ref: 'decision:d1', match: 'semantic' });
  });

  it('checks project_id through ctx.scoped.project first: a foreign project 404s with no repo search', async () => {
    const { ctx, embedder, calls } = ctxFor({});
    await expect(searchMemory(ctx, { query: 'x', project_id: 'px' }, { embedder })).rejects.toBeInstanceOf(HttpError);
    expect(calls.nearestAny).not.toHaveBeenCalled();
    expect(calls.nearest).not.toHaveBeenCalled();
    expect(calls.decisionTextSearch).not.toHaveBeenCalled();
    expect(calls.itemTextSearch).not.toHaveBeenCalled();
  });

  it('checks project_id through ctx.scoped.project first: a missing project also 404s', async () => {
    const { ctx, embedder } = ctxFor({});
    await expect(searchMemory(ctx, { query: 'x', project_id: 'nope' }, { embedder })).rejects.toBeInstanceOf(HttpError);
  });

  it('kinds: ["decision"] searches only chat_decisions', async () => {
    const { ctx, embedder, calls } = ctxFor({ vecDecisions: [decision({ id: 'd1' })], textDecisions: [decisionRanked({ id: 'd1', rank: 1 })] });
    const r = await searchMemory(ctx, { query: 'x', kinds: ['decision'] }, { embedder });
    expect(calls.nearest).not.toHaveBeenCalled();
    expect(calls.itemTextSearch).not.toHaveBeenCalled();
    expect(r.results.every((x) => x.kind === 'decision')).toBe(true);
  });

  it('kinds: ["doc"] searches only items of that kind', async () => {
    const { ctx, embedder, calls } = ctxFor({ vecItems: [item({ id: 'i1', kind: 'doc' })], textItems: [item({ id: 'i1', kind: 'doc', rank: 1 })] });
    const r = await searchMemory(ctx, { query: 'x', kinds: ['doc'] }, { embedder });
    expect(calls.nearestAny).not.toHaveBeenCalled();
    expect(calls.decisionTextSearch).not.toHaveBeenCalled();
    expect(calls.nearest).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['doc'] }), expect.anything(), expect.anything());
    expect(calls.itemTextSearch).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['doc'] }), expect.anything(), expect.anything());
    expect(r.results.every((x) => x.kind === 'doc')).toBe(true);
  });

  it('an embedder that rejects falls back to text-only results, similarity null, match "text", and never throws', async () => {
    const failing: Embedder = { embed: vi.fn(async () => { throw new Error('boom'); }) };
    const { ctx, calls } = ctxFor({ textDecisions: [decisionRanked({ id: 'd1', rank: 1 })] });
    const r = await searchMemory(ctx, { query: 'x' }, { embedder: failing });
    expect(calls.nearestAny).not.toHaveBeenCalled();
    expect(calls.nearest).not.toHaveBeenCalled();
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ similarity: null, match: 'text' });
  });

  it('an embedder that times out also falls back to text-only, no throw', async () => {
    const hanging: Embedder = { embed: () => new Promise(() => {}) };
    const { ctx } = ctxFor({ textItems: [item({ id: 'i1', kind: 'note', rank: 1 })] });
    const r = await searchMemory(ctx, { query: 'x' }, { embedder: hanging });
    expect(r.results[0]).toMatchObject({ similarity: null, match: 'text' });
  }, 10_000);

  it('excerpts are cleaned and cut to 600 chars', async () => {
    const dirty = `‮${'a'.repeat(700)}`;
    const { ctx, embedder } = ctxFor({ vecItems: [item({ id: 'i1', kind: 'note', text: dirty })] });
    const r = await searchMemory(ctx, { query: 'x' }, { embedder });
    expect(r.results[0].excerpt.length).toBeLessThanOrEqual(600);
    expect(r.results[0].excerpt).not.toContain('‮');
  });

  it('limit defaults to 8 and is respected when given', async () => {
    const items = Array.from({ length: 12 }, (_, i) => item({ id: `i${i}`, kind: 'note', similarity: 1 - i / 100 }));
    const { ctx, embedder } = ctxFor({ vecItems: items });
    const r1 = await searchMemory(ctx, { query: 'x' }, { embedder });
    expect(r1.results).toHaveLength(8);
    const r2 = await searchMemory(ctx, { query: 'x', limit: 3 }, { embedder });
    expect(r2.results).toHaveLength(3);
    expect(r1.note).toBe(MEMORY_NOTE);
    expect(r2.note).toBe(MEMORY_NOTE);
  });

  it('always filters by ctx.scope.user.id', async () => {
    const { ctx, embedder, calls } = ctxFor({ user: 'u7', vecDecisions: [decision({ id: 'd1' })], vecItems: [item({ id: 'i1', kind: 'note' })] });
    await searchMemory(ctx, { query: 'x' }, { embedder });
    expect(calls.nearestAny).toHaveBeenCalledWith('u7', expect.anything(), expect.anything());
    expect(calls.decisionTextSearch).toHaveBeenCalledWith('u7', expect.anything(), expect.anything());
    expect(calls.nearest).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'u7' }), expect.anything(), expect.anything());
    expect(calls.itemTextSearch).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'u7' }), expect.anything(), expect.anything());
  });
});
