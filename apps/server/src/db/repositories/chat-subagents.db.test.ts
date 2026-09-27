import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { PANEL_RECENT_MS } from '../../chat/subagent-view.js';
import { ChatRepository } from './chat.js';
import { ChatSubagentsRepository } from './chat-subagents.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatSubagentsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatSubagentsRepository;
  let userId: string;
  let otherUserId: string;
  let conv: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatSubagentsRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    conv = (await new ChatRepository(db).getOrCreateForUser(userId)).id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades conversations and subagents
    await db.$disconnect();
  });

  it('starts once per task and lists running plus recently ended, newest first', async () => {
    const a = await repo.start({ conversation_id: conv, task_id: 't1', tool_use_id: 'u1', description: 'Buscar CI', subagent_type: 'general-purpose' });
    const again = await repo.start({ conversation_id: conv, task_id: 't1', tool_use_id: 'u1', description: 'outro', subagent_type: null });
    expect(again.id).toBe(a.id);
    expect(again.description).toBe('Buscar CI');
    const b = await repo.start({ conversation_id: conv, task_id: 't2', tool_use_id: 'u2', description: 'Abrir aba', subagent_type: null });
    await repo.setStatus(b.id, 'completed');
    const old = await repo.start({ conversation_id: conv, task_id: 't3', tool_use_id: 'u3', description: 'Velho', subagent_type: null });
    await repo.setStatus(old.id, 'failed');
    const later = new Date(Date.now() + PANEL_RECENT_MS + 60_000);
    expect((await repo.listForPanel(conv)).map((s) => s.task_id)).toEqual(['t3', 't2', 't1']);
    expect((await repo.listForPanel(conv, later)).map((s) => s.task_id)).toEqual(['t1']);
  });

  it('sets ended_at on final states and clears it when back to running', async () => {
    const s = await repo.start({ conversation_id: conv, task_id: 't4', tool_use_id: 'u4', description: 'd', subagent_type: null });
    expect((await repo.setStatus(s.id, 'stopping'))?.ended_at).toBeNull();
    expect((await repo.setStatus(s.id, 'stopped'))?.ended_at).not.toBeNull();
  });

  it('finds by id only for the owner and interrupts running ones', async () => {
    const s = await repo.start({ conversation_id: conv, task_id: 't5', tool_use_id: 'u5', description: 'd', subagent_type: null });
    expect(await repo.findByIdForUser(s.id, otherUserId)).toBeUndefined();
    expect((await repo.findByIdForUser(s.id, userId))?.id).toBe(s.id);
    const changed = await repo.interruptRunning(conv);
    expect(changed.map((c) => c.id)).toContain(s.id);
    expect(changed.every((c) => c.status === 'interrupted')).toBe(true);
  });

  it('lists rows by id, in no particular guaranteed order but complete', async () => {
    const a = await repo.start({ conversation_id: conv, task_id: 't6', tool_use_id: 'u6', description: 'd', subagent_type: null });
    const b = await repo.start({ conversation_id: conv, task_id: 't7', tool_use_id: 'u7', description: 'd', subagent_type: null });
    const rows = await repo.listByIds([a.id, b.id, 'missing']);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});
