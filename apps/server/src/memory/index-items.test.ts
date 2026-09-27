import { describe, expect, it, vi } from 'vitest';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { MemoryItem, NewMemoryItem } from '../db/repositories/memory-items.js';
import type { Task } from '../db/repositories/types.js';
import { EmbedError } from '../chat/embeddings.js';
import { embedPendingItems, indexActions, indexMessage, indexNote, indexTasks } from './index-items.js';
import { ITEM_TEXT_MAX } from './text.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const embedder = () => ({ embed: vi.fn(async (texts: string[]) => ({ model: 'm', vectors: texts.map(() => [1, 0]) })) });

/** A row `upsertMany` would return: every stored item, always with a fresh id, always needing an
 *  embedding (the repository never returns a row that kept its embedding). */
const toRow = (it: NewMemoryItem): MemoryItem => ({
  id: it.id ?? `mem-${Math.random().toString(36).slice(2)}`,
  owner_id: it.owner_id,
  project_id: it.project_id,
  project_name: null,
  kind: it.kind,
  source_id: it.source_id,
  chunk_index: it.chunk_index,
  title: it.title,
  text: it.text,
  trust: it.trust,
  content_hash: 'h',
  source_hash: null,
  embed_model: null,
  source_at: it.source_at.toISOString(),
  created_at: '2026-09-26T00:00:00.000Z',
  updated_at: '2026-09-26T00:00:00.000Z',
});

function fakeMemoryItems(overrides: Record<string, unknown> = {}) {
  return {
    upsertMany: vi.fn(async (items: NewMemoryItem[]) => items.map(toRow)),
    setEmbedding: vi.fn(async () => {}),
    listToEmbed: vi.fn(async () => []),
    deleteBySource: vi.fn(async () => 0),
    listSourceAt: vi.fn(async () => new Map<string, string>()),
    ...overrides,
  };
}

describe('indexMessage', () => {
  const msg = { id: 'msg1', owner_id: 'u1', project_id: 'p1', text: 'Sim, pode seguir', created_at: '2026-09-26T10:00:00.000Z' };

  it('upserts a single person-trust chunk and fires the embed', async () => {
    const memoryItems = fakeMemoryItems();
    const e = embedder();
    await indexMessage({ memoryItems } as never, msg, { embedder: e, log: log() });
    expect(memoryItems.upsertMany).toHaveBeenCalledWith([
      { owner_id: 'u1', project_id: 'p1', kind: 'message', source_id: 'msg1', chunk_index: 0, title: 'Mensagem', text: 'Sim, pode seguir', trust: 'person', source_at: new Date(msg.created_at) },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(memoryItems.setEmbedding).toHaveBeenCalledTimes(1);
  });

  it('splits a message over 1200 chars into consecutive chunks', async () => {
    const memoryItems = fakeMemoryItems();
    const longText = 'a'.repeat(ITEM_TEXT_MAX + 500);
    await indexMessage({ memoryItems } as never, { ...msg, text: longText }, { embedder: null, log: log() });
    const items = memoryItems.upsertMany.mock.calls[0]![0] as NewMemoryItem[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ chunk_index: 0, source_id: 'msg1', text: longText.slice(0, ITEM_TEXT_MAX) });
    expect(items[1]).toMatchObject({ chunk_index: 1, source_id: 'msg1', text: longText.slice(ITEM_TEXT_MAX) });
    expect(items.every((i) => i.text.length <= ITEM_TEXT_MAX)).toBe(true);
  });

  it('resolves and logs only a code when the embedder rejects, never the text or the title', async () => {
    const memoryItems = fakeMemoryItems();
    const failing = { embed: vi.fn(async () => { throw new EmbedError('EMBED_UNREACHABLE'); }) };
    const l = log();
    await expect(indexMessage({ memoryItems } as never, msg, { embedder: failing, log: l })).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(l.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'EMBED_UNREACHABLE' }), expect.any(String));
    for (const call of l.warn.mock.calls) {
      expect(Object.keys(call[0] as object)).not.toContain('text');
      expect(Object.keys(call[0] as object)).not.toContain('title');
    }
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('Sim, pode seguir');
  });

  it('resolves when the repository rejects', async () => {
    const memoryItems = fakeMemoryItems({ upsertMany: vi.fn(async () => { throw Object.assign(new Error('db down'), { code: 'P2024' }); }) });
    const l = log();
    await expect(indexMessage({ memoryItems } as never, msg, { embedder: embedder(), log: l })).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith({ code: 'P2024' }, expect.any(String));
  });
});

function actionRow(overrides: Partial<ChatAction> = {}): ChatAction {
  return {
    id: 'act1',
    conversation_id: 'c1',
    message_id: null,
    tool: 'create_task',
    args: { title: 'Corrigir o build', project_id: 'p1' },
    class: 'write',
    status: 'approved',
    idempotency_key: null,
    machine_id: null,
    project_id: 'p1',
    tab_id: null,
    grant_id: null,
    error_code: null,
    duration_ms: null,
    decided_by: 'u1',
    decided_at: '2026-09-26T11:00:00.000Z',
    injected_at: null,
    created_at: '2026-09-26T10:59:00.000Z',
    ...overrides,
  };
}

function fakeActionRepos(memoryItems = fakeMemoryItems()) {
  return {
    memoryItems,
    tabs: { findByIdsForOwner: vi.fn(async () => []) },
    tasks: { findByIdsForOwner: vi.fn(async () => []) },
    tickets: { findByIdsForOwner: vi.fn(async () => []) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === 'u1' && ids.includes('p1') ? [{ id: 'p1', name: 'app' }] : [])) },
    machines: { findByIdsForOwner: vi.fn(async () => []) },
    apiTokens: { listByUser: vi.fn(async () => []) },
  };
}

describe('indexActions', () => {
  it('indexes an approved and a denied action as derived, trust person never used', async () => {
    const memoryItems = fakeMemoryItems();
    const repos = fakeActionRepos(memoryItems);
    const approved = actionRow({ id: 'a1', status: 'approved' });
    const denied = actionRow({ id: 'a2', status: 'denied', tool: 'delete_task', args: { task_id: 't9', project_id: 'p1' } });
    await indexActions(repos as never, 'u1', [approved, denied], { embedder: null, log: log() });
    expect(memoryItems.upsertMany).toHaveBeenCalledTimes(1);
    const items = memoryItems.upsertMany.mock.calls[0]![0] as NewMemoryItem[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'action', trust: 'derived', source_id: 'a1', owner_id: 'u1', project_id: 'p1' });
    expect(items[0]!.text).toMatch(/^Usuário aprovou: /);
    expect(items[1]).toMatchObject({ kind: 'action', trust: 'derived', source_id: 'a2' });
    expect(items[1]!.text).toMatch(/^Usuário negou: /);
  });

  it('indexes nothing for a pending or expired action', async () => {
    const memoryItems = fakeMemoryItems();
    const repos = fakeActionRepos(memoryItems);
    await indexActions(repos as never, 'u1', [actionRow({ status: 'pending' }), actionRow({ id: 'a3', status: 'expired' })], { embedder: null, log: log() });
    expect(memoryItems.upsertMany).not.toHaveBeenCalled();
  });

  it('resolves and logs a code when the repository rejects', async () => {
    const memoryItems = fakeMemoryItems({ upsertMany: vi.fn(async () => { throw Object.assign(new Error('db down'), { code: 'P2024' }); }) });
    const repos = fakeActionRepos(memoryItems);
    const l = log();
    await expect(indexActions(repos as never, 'u1', [actionRow()], { embedder: null, log: l })).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith({ code: 'P2024' }, expect.any(String));
  });
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    project_id: 'p1',
    type: 'task',
    number: 12,
    ref: 'TER-12',
    title: 'Corrigir o build',
    description: 'Ver o log do CI',
    status: 'todo',
    position: 0,
    external_ref: null,
    external_key: null,
    tab_id: null,
    parent_id: null,
    epic_id: null,
    column_id: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-26T09:00:00.000Z',
    ...overrides,
  };
}

describe('indexTasks', () => {
  it('upserts a task newer than its stored source_at', async () => {
    const memoryItems = fakeMemoryItems({ listSourceAt: vi.fn(async () => new Map()) });
    const t = task();
    const tasks = { listChangedForOwner: vi.fn(async () => [t]), findByIdsForOwner: vi.fn(async () => []) };
    const n = await indexTasks({ memoryItems, tasks } as never, 'u1', { embedder: null, log: log() });
    expect(n).toBe(1);
    expect(memoryItems.upsertMany).toHaveBeenCalledWith([
      { owner_id: 'u1', project_id: 'p1', kind: 'task', source_id: 't1', chunk_index: 0, title: 'TER-12 · Corrigir o build', text: 'Ver o log do CI', trust: 'derived', source_at: new Date(t.updated_at) },
    ]);
  });

  it('does not upsert a task whose updated_at did not move past the stored source_at', async () => {
    const t = task();
    const memoryItems = fakeMemoryItems({ listSourceAt: vi.fn(async () => new Map([[t.id, t.updated_at]])) });
    const tasks = { listChangedForOwner: vi.fn(async () => [t]), findByIdsForOwner: vi.fn(async () => [t]) };
    const n = await indexTasks({ memoryItems, tasks } as never, 'u1', { embedder: null, log: log() });
    expect(n).toBe(0);
    expect(memoryItems.upsertMany).not.toHaveBeenCalled();
  });

  it('uses an empty string for a card with no description', async () => {
    const memoryItems = fakeMemoryItems({ listSourceAt: vi.fn(async () => new Map()) });
    const t = task({ description: null });
    const tasks = { listChangedForOwner: vi.fn(async () => [t]), findByIdsForOwner: vi.fn(async () => []) };
    await indexTasks({ memoryItems, tasks } as never, 'u1', { embedder: null, log: log() });
    expect(memoryItems.upsertMany).toHaveBeenCalledWith([expect.objectContaining({ text: '' })]);
  });

  it('deletes items of a task that no longer exists', async () => {
    const memoryItems = fakeMemoryItems({ listSourceAt: vi.fn(async () => new Map([['gone1', '2026-09-01T00:00:00.000Z'], ['still1', '2026-09-01T00:00:00.000Z']])) });
    const tasks = { listChangedForOwner: vi.fn(async () => []), findByIdsForOwner: vi.fn(async () => [task({ id: 'still1' })]) };
    const n = await indexTasks({ memoryItems, tasks } as never, 'u1', { embedder: null, log: log() });
    expect(n).toBe(0);
    expect(memoryItems.deleteBySource).toHaveBeenCalledWith('task', ['gone1']);
  });

  it('fires an immediate embed for the upserted rows when an embedder is configured', async () => {
    const memoryItems = fakeMemoryItems({ listSourceAt: vi.fn(async () => new Map()) });
    const t = task();
    const tasks = { listChangedForOwner: vi.fn(async () => [t]), findByIdsForOwner: vi.fn(async () => []) };
    const e = embedder();
    await indexTasks({ memoryItems, tasks } as never, 'u1', { embedder: e, log: log() });
    await new Promise((r) => setTimeout(r, 0));
    expect(memoryItems.setEmbedding).toHaveBeenCalledTimes(1);
  });
});

describe('indexNote', () => {
  it('writes a note item whose source_id is its own id', async () => {
    const memoryItems = fakeMemoryItems();
    const note = { owner_id: 'u1', project_id: 'p1', question: 'Isolamento?', decision: 'Usar git worktree', reason: 'evita conflito', sources: ['decision:d1', 'task:t1'] };
    const item = await indexNote({ memoryItems } as never, note, { embedder: null, log: log() });
    expect(memoryItems.upsertMany).toHaveBeenCalledTimes(1);
    const [inserted] = memoryItems.upsertMany.mock.calls[0]![0] as NewMemoryItem[];
    expect(inserted!.id).toBeTruthy();
    expect(inserted!.source_id).toBe(inserted!.id);
    expect(inserted).toMatchObject({ owner_id: 'u1', project_id: 'p1', kind: 'note', chunk_index: 0, title: 'Isolamento?', trust: 'derived' });
    expect(inserted!.text).toBe('Decisão: Usar git worktree\nMotivo: evita conflito\nFontes: decision:d1, task:t1');
    expect(item.id).toBe(inserted!.id);
  });

  it('throws when the repository rejects, so the caller (the tool) can report it', async () => {
    const memoryItems = fakeMemoryItems({ upsertMany: vi.fn(async () => { throw new Error('db down'); }) });
    const note = { owner_id: 'u1', project_id: null, question: 'Q', decision: 'D', reason: 'R', sources: [] as string[] };
    await expect(indexNote({ memoryItems } as never, note, { embedder: null, log: log() })).rejects.toThrow('db down');
  });
});

describe('embedPendingItems', () => {
  it('embeds the backlog in one call and writes each embedding', async () => {
    const rows = [{ id: 'm1', title: 'Mensagem', text: 'oi' }];
    const memoryItems = fakeMemoryItems({ listToEmbed: vi.fn(async () => rows) });
    const e = embedder();
    const n = await embedPendingItems({ memoryItems } as never, e, 32);
    expect(n).toBe(1);
    expect(memoryItems.listToEmbed).toHaveBeenCalledWith(32);
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(memoryItems.setEmbedding).toHaveBeenCalledWith('m1', [1, 0], 'm');
  });

  it('returns 0 without calling the embedder when nothing is pending', async () => {
    const memoryItems = fakeMemoryItems({ listToEmbed: vi.fn(async () => []) });
    const e = embedder();
    expect(await embedPendingItems({ memoryItems } as never, e)).toBe(0);
    expect(e.embed).not.toHaveBeenCalled();
  });
});
