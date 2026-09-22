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

  it('returns the newest messages, in chronological order, when the conversation is longer than the limit', async () => {
    // Regression: `asc` + `take` pinned the window to the *oldest* messages, so past the limit the
    // user's own message and its answer were never in the payload again.
    const longUserId = newId();
    await db.user.create({ data: { id: longUserId, email: `${longUserId}@test.local`, name: 'test' } });
    try {
      const c = await repo.getOrCreateForUser(longUserId);
      const base = Date.UTC(2026, 0, 1);
      // Explicit, distinct timestamps: rows written in the same millisecond would leave the order
      // to the (random) id tiebreak and make the assertion meaningless.
      await db.chatMessage.createMany({
        data: Array.from({ length: 205 }, (_, i) => ({
          id: newId(),
          conversationId: c.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          text: `#${i + 1}`,
          createdAt: new Date(base + i * 1000),
        })),
      });

      const page = await repo.listMessages(c.id);
      expect(page).toHaveLength(200);
      expect(page[0].text).toBe('#6'); // the 5 oldest fell off the window, not the 5 newest
      expect(page.at(-1)!.text).toBe('#205');
      expect(page.map((m) => m.text)).toEqual(Array.from({ length: 200 }, (_, i) => `#${i + 6}`));

      const three = await repo.listMessages(c.id, 3);
      expect(three.map((m) => m.text)).toEqual(['#203', '#204', '#205']);
    } finally {
      await db.user.delete({ where: { id: longUserId } }); // cascades the conversation and its messages
    }
  });

  it('stores the host pair, and only starts a fresh CLI session when the pair really moved', async () => {
    const session = '3f1e9b1e-0000-4000-8000-000000000099';
    const c = await repo.getOrCreateForUser(userId);
    await repo.setCliSession(c.id, session);
    const machine = await db.machine.create({ data: { id: newId(), name: 'jarvis', type: 'agent', ownerId: userId } });
    const second = await db.machine.create({ data: { id: newId(), name: 'macbook', type: 'agent', ownerId: userId } });
    const account = await db.aiAccount.create({ data: { id: newId(), provider: 'claude', label: 'trabalho', machineId: machine.id, configDir: '/home/u/.claude-work' } });

    // Naming the machine the conversation was already running on (nothing was stored: one machine is
    // resolved on the fly) moves no host, so the model keeps the memory of the conversation.
    const first = await repo.setHost(c.id, { machine_id: machine.id, ai_account_id: null });
    expect(first).toMatchObject({ machine_id: machine.id, ai_account_id: null, cli_session_id: session });

    // And picking the very same pair again — the same click twice, or a settings screen that saves
    // whatever is selected — is not a host change either.
    expect((await repo.setHost(c.id, { machine_id: machine.id, ai_account_id: null })).cli_session_id).toBe(session);

    // A second login on the same machine *is* another config directory, so the session is not there.
    const hosted = await repo.setHost(c.id, { machine_id: machine.id, ai_account_id: account.id });
    expect(hosted).toMatchObject({ machine_id: machine.id, ai_account_id: account.id, cli_session_id: null });

    // So is another machine: the session lives in the config dir of the machine that ran it, and
    // keeping the uuid would ask the new host to resume a session it has never seen.
    await repo.setCliSession(c.id, session);
    expect((await repo.setHost(c.id, { machine_id: second.id, ai_account_id: null })).cli_session_id).toBeNull();
    await repo.setHost(c.id, { machine_id: machine.id, ai_account_id: account.id });
    await db.machine.delete({ where: { id: second.id } });

    // "One conversation per user" must survive a host being chosen: the partial unique index no longer
    // keys on machine_id, so a second concurrent create still loses (this is what getOrCreateForUser's
    // create-then-re-read fallback relies on).
    await expect(db.chatConversation.create({ data: { id: newId(), userId } })).rejects.toThrow();

    await db.aiAccount.delete({ where: { id: account.id } });
    expect((await repo.getOrCreateForUser(userId)).ai_account_id).toBeNull(); // ON DELETE SET NULL
    await db.machine.delete({ where: { id: machine.id } });
    const orphaned = await repo.getOrCreateForUser(userId);
    expect(orphaned.machine_id).toBeNull();
    expect(orphaned.id).toBe(c.id); // the conversation itself, and its history, survive
  });

  it('pins a host only while the conversation names none, so a run can never move a chosen one', async () => {
    const session = '3f1e9b1e-0000-4000-8000-000000000077';
    const c = await repo.getOrCreateForUser(userId);
    const ran = await db.machine.create({ data: { id: newId(), name: 'jarvis', type: 'agent', ownerId: userId } });
    const other = await db.machine.create({ data: { id: newId(), name: 'macbook', type: 'agent', ownerId: userId } });
    try {
      // The conversation `resolveHost` auto-picks for: one machine, nothing stored.
      await db.chatConversation.update({ where: { id: c.id }, data: { machineId: null, aiAccountId: null } });
      await repo.setCliSession(c.id, session);

      await repo.pinHostMachine(c.id, ran.id);
      const pinned = await repo.getOrCreateForUser(userId);
      // Recorded, and the session left exactly where it was: this is a note of where a run happened,
      // never a host change.
      expect(pinned.machine_id).toBe(ran.id);
      expect(pinned.cli_session_id).toBe(session);

      // The guard, and the only reason it lives in the SQL rather than in a caller: this conversation
      // now names a host, and a run on any *other* machine must not rewrite it. That happens for real —
      // the named machine stops being a candidate (handed to someone else, or turned into an ssh
      // machine), `resolveHost` picks the survivor, and a pin without `where machineId: null` would
      // move a host the person chose, in silence. It would also erase the very difference the pin
      // exists to create, so the header would stop warning that the session is not on the machine that
      // is about to answer.
      await repo.pinHostMachine(c.id, other.id);
      const unmoved = await repo.getOrCreateForUser(userId);
      expect(unmoved.machine_id).toBe(ran.id);
      expect(unmoved.cli_session_id).toBe(session);

      // …and a host the *user* chose is the same row and the same guard: setHost stores it, and no run
      // can take it from there either.
      await repo.setHost(c.id, { machine_id: other.id, ai_account_id: null });
      await repo.pinHostMachine(c.id, ran.id);
      expect((await repo.getOrCreateForUser(userId)).machine_id).toBe(other.id);
    } finally {
      await repo.setCliSession(c.id, null);
      await db.machine.deleteMany({ where: { id: { in: [ran.id, other.id] } } }); // nulls machine_id again
    }
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
