import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { MemoryItemsRepository } from '../db/repositories/memory-items.js';
import type { Machine } from '../db/repositories/types.js';
import { newId } from '../lib/ids.js';
import { indexDocsForLink, type DocsExec } from './docs.js';

const sha = (c: string) => c.repeat(64);
const spec = (n: string) => `docs/superpowers/specs/${n}.md`;

/** An in-memory checkout the test edits between passes: path → { sha, text }. */
function checkout(files: Map<string, { sha: string; text: string }>): DocsExec {
  const read = async (_m: Machine, _c: string, paths: string[]) =>
    paths
      .filter((p) => files.has(p))
      .map((p) => `B\t${Buffer.byteLength(files.get(p)!.text)}\t${p}\n${Buffer.from(files.get(p)!.text).toString('base64')}\nE`)
      .join('\n') + '\n';
  return {
    scan: async () => [...files].map(([p, f]) => `F\t${f.sha}\t${Buffer.byteLength(f.text)}\t${p}`).join('\n') + '\n',
    read,
    readLessons: read,
  };
}

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('indexDocsForLink (Postgres)', () => {
  let db: PrismaClient;
  let repos: { memoryItems: MemoryItemsRepository };
  let ownerId: string;
  let projectId: string;
  const linkId = newId();

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = { memoryItems: new MemoryItemsRepository(db) };
    ownerId = newId();
    projectId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'o' } });
    await db.project.create({ data: { id: projectId, ownerId, key: 'D' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'p' } });
  });

  afterAll(async () => {
    await db.memoryItem.deleteMany({ where: { ownerId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db?.$disconnect();
  });

  const rows = () =>
    db.memoryItem.findMany({ where: { kind: 'doc', sourceId: { startsWith: `${linkId}:` } }, orderBy: [{ sourceId: 'asc' }, { chunkIndex: 'asc' }], select: { sourceId: true, chunkIndex: true, sourceHash: true, trust: true, projectId: true, ownerId: true } });

  it('indexes, skips unchanged files, shrinks a re-chunked file and removes a gone one', async () => {
    const files = new Map([
      [spec('a'), { sha: sha('a'), text: '# A\n\nalpha\n\n# B\n\nbravo\n\n# C\n\ncharlie\n' }],
      [spec('b'), { sha: sha('b'), text: 'beta' }],
    ]);
    const exec = checkout(files);
    const read = vi.spyOn(exec, 'read');
    const link = { id: linkId, project_id: projectId, owner_id: ownerId, cwd: '/r', machine: { id: 'm', type: 'agent' } as Machine };
    const deps = { embedder: null, log: { info: vi.fn(), warn: vi.fn() }, exec };

    expect(await indexDocsForLink(repos, link, deps)).toEqual({ read: 2, removed: 0 });
    expect((await rows()).map((r) => [r.sourceId.slice(linkId.length + 1), r.chunkIndex, r.sourceHash])).toEqual([
      [spec('a'), 0, sha('a')],
      [spec('a'), 1, sha('a')],
      [spec('a'), 2, sha('a')],
      [spec('b'), 0, sha('b')],
    ]);
    expect((await rows()).every((r) => r.trust === 'derived' && r.projectId === projectId && r.ownerId === ownerId)).toBe(true);

    read.mockClear();
    expect(await indexDocsForLink(repos, link, deps)).toEqual({ read: 0, removed: 0 });
    expect(read).not.toHaveBeenCalled();

    files.set(spec('a'), { sha: sha('c'), text: '# Só um\n\ntexto' });
    files.delete(spec('b'));
    expect(await indexDocsForLink(repos, link, deps)).toEqual({ read: 1, removed: 1 });
    expect((await rows()).map((r) => [r.sourceId.slice(linkId.length + 1), r.chunkIndex, r.sourceHash])).toEqual([[spec('a'), 0, sha('c')]]);

    // An offline machine deletes nothing.
    const offline = { ...exec, scan: async () => Promise.reject(Object.assign(new Error('x'), { code: 'AGENT_OFFLINE' })) };
    expect(await indexDocsForLink(repos, link, { ...deps, exec: offline })).toEqual({ read: 0, removed: 0 });
    expect((await rows()).length).toBe(1);
  });
});
