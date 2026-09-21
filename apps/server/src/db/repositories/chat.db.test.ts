import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatRepository;
  let userId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatRepository(db);
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
  });

  afterAll(async () => {
    await db.user.delete({ where: { id: userId } }); // cascades the conversation and its messages
    await db.$disconnect();
  });

  it('creates one conversation per user and returns the same one after that', async () => {
    const first = await repo.getOrCreateForUser(userId);
    const again = await repo.getOrCreateForUser(userId);
    expect(again.id).toBe(first.id);
    expect(first.cli_session_id).toBeNull();
    expect(first.review_mode).toBe(false);
  });

  it('stores the cli session id, appends messages in order and bumps last_message_at', async () => {
    const c = await repo.getOrCreateForUser(userId);
    await repo.setCliSession(c.id, '3f1e9b1e-0000-4000-8000-000000000001');

    const user = await repo.addMessage({ conversation_id: c.id, role: 'user', text: 'o que está rodando?' });
    const assistant = await repo.addMessage({ conversation_id: c.id, role: 'assistant', text: '' });
    await repo.updateMessage(assistant.id, { text: 'Nada rodando agora.', usage: { input_tokens: 10 } });

    const messages = await repo.listMessages(c.id);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'o que está rodando?'],
      ['assistant', 'Nada rodando agora.'],
    ]);
    expect(messages[1].usage).toEqual({ input_tokens: 10 });

    const reloaded = await repo.getOrCreateForUser(userId);
    expect(reloaded.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-000000000001');
    expect(reloaded.last_message_at).not.toBeNull();
  });

  it('keeps an assistant failure as an error code without losing the text so far', async () => {
    const c = await repo.getOrCreateForUser(userId);
    const m = await repo.addMessage({ conversation_id: c.id, role: 'assistant', text: 'comecei a olhar' });
    const failed = await repo.updateMessage(m.id, { error_code: 'RUNNER_FAILED' });
    expect(failed.error_code).toBe('RUNNER_FAILED');
    expect(failed.text).toBe('comecei a olhar');
  });

  it('never creates two conversations for the same user under a concurrent first load', async () => {
    const raceUserId = newId();
    await db.user.create({ data: { id: raceUserId, email: `${raceUserId}@test.local`, name: 'test' } });
    try {
      // 2 calls alone are not enough to reliably overlap on a fresh connection pool in this suite
      // (the pool's connection warm-up serializes a first small burst); 20 concurrent calls do
      // reliably race, exercising the partial unique index and the create/re-read fallback.
      const results = await Promise.all(Array.from({ length: 20 }, () => repo.getOrCreateForUser(raceUserId)));
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      expect(await db.chatConversation.count({ where: { userId: raceUserId } })).toBe(1);
    } finally {
      await db.user.delete({ where: { id: raceUserId } }); // cascades the conversation
    }
  });
});
