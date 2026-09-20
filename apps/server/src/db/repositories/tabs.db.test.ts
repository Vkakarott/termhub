import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { needsYou } from '../../monitor/state.js';
import { TabsRepository } from './tabs.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see tasks.db.test.ts / the plan for the local Docker recipe).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TabsRepository.markSeen / clearState (Postgres)', () => {
  let db: PrismaClient;
  let repo: TabsRepository;
  let machineId: string;
  let projectId: string;
  let tabId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TabsRepository(db);
  });

  beforeEach(async () => {
    machineId = newId();
    projectId = newId();
    tabId = newId();
    await db.machine.create({ data: { id: machineId, name: 'test', type: 'agent' } });
    await db.project.create({ data: { id: projectId, machineId, name: 'p', cwd: '/tmp' } });
    await db.tab.create({ data: { id: tabId, projectId, name: 't', tmuxSession: `th-${tabId}` } });
    return async () => {
      await db.machine.delete({ where: { id: machineId } }); // cascades project and tab
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('writes state_seen_at for a tab waiting for the person', async () => {
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'Posso seguir?' });
    const now = new Date();
    const updated = await repo.markSeen(tabId, now);
    expect(updated?.state_seen_at).toBe(now.toISOString());
  });

  it('returns undefined for a tab that is not waiting (working, idle, or never reported)', async () => {
    expect(await repo.markSeen(tabId)).toBeUndefined(); // state is null: never reported

    await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
    expect(await repo.markSeen(tabId)).toBeUndefined();

    await repo.recordEvent(tabId, { kind: 'idle', tool: 'claude', text: null });
    expect(await repo.markSeen(tabId)).toBeUndefined();
  });

  it('returns undefined when already seen for the current state_at', async () => {
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
    expect(await repo.markSeen(tabId)).toBeDefined();
    expect(await repo.markSeen(tabId)).toBeUndefined(); // already seen, state_at unchanged
  });

  it('needs you again after a new hook event bumps state_at, and markSeen writes again', async () => {
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
    const firstSeen = await repo.markSeen(tabId);
    expect(firstSeen).toBeDefined();

    await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'second?' });
    const reloaded = await repo.findById(tabId);
    expect(reloaded?.state_seen_at).toBe(firstSeen!.state_seen_at); // stale: older than the new state_at

    const secondSeen = await repo.markSeen(tabId);
    expect(secondSeen).toBeDefined();
    expect(secondSeen!.state_seen_at).not.toBe(firstSeen!.state_seen_at);
  });

  it('clearState also clears state_seen_at', async () => {
    await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
    await repo.markSeen(tabId);
    await repo.clearState(tabId);
    const cleared = await repo.findById(tabId);
    expect(cleared).toMatchObject({ state: null, state_at: null, state_seen_at: null });
  });

  describe('created_by_token_id / countOpenByToken', () => {
    it('records which token opened a tab and counts the ones still open', async () => {
      const a = await repo.create(projectId, 'T1', { created_by_token_id: 'tok1' });
      await repo.create(projectId, 'T2', { created_by_token_id: 'tok1' });
      await repo.create(projectId, 'T3');

      expect(a.created_by_token_id).toBe('tok1');
      expect(await repo.countOpenByToken('tok1')).toBe(2);
      expect(await repo.countOpenByToken('tok2')).toBe(0);

      await repo.delete(a.id);
      expect(await repo.countOpenByToken('tok1')).toBe(1);
    });
  });

  describe('recordEvent — the same Claude wait (Stop, then idle_prompt ~1min later) stays seen', () => {
    it('carries the seen mark forward: seen waiting_input + a new waiting_input stays seen', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
      await repo.markSeen(tabId);
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
      expect(needsYou(updated)).toBe(false);
      expect(updated.state_seen_at).toBe(updated.state_at);
    });

    it('re-arms once the wait passes through another state (working) before returning to waiting_input', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
      await repo.markSeen(tabId);
      await repo.recordEvent(tabId, { kind: 'working', tool: 'claude', text: null });
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
      expect(needsYou(updated)).toBe(true);
    });

    it('re-arms on waiting_permission right after a seen waiting_input (a permission prompt is always a new ask)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
      await repo.markSeen(tabId);
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?' });
      expect(needsYou(updated)).toBe(true);
    });

    it('re-arms on a second waiting_permission even if the previous one was also seen', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'first?' });
      await repo.markSeen(tabId);
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_permission', tool: 'claude', text: 'second?' });
      expect(needsYou(updated)).toBe(true);
    });

    it('an unseen waiting_input still needs you after another waiting_input (nothing to carry)', async () => {
      await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: 'first?' });
      const { tab: updated } = await repo.recordEvent(tabId, { kind: 'waiting_input', tool: 'claude', text: null });
      expect(needsYou(updated)).toBe(true);
    });
  });
});
