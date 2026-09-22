import { expect, it, vi } from 'vitest';
import type { AiAccount, Machine, User } from '../db/repositories/types.js';
import { resolveHost, type HostChoice, type HostContext } from './host.js';

const user = { id: 'u1', email: 'p@test' } as unknown as User;

const machine = (id: string, name: string, over: Partial<Machine> = {}): Machine => ({
  id,
  name,
  host: null,
  ssh_user: null,
  ssh_port: 22,
  type: 'agent',
  os: 'linux',
  capabilities: [],
  checked_at: null,
  agent_version: '0.4.0',
  agent_last_seen_at: null,
  agent_auto_update: false,
  is_local: false,
  owner_id: 'u1',
  owner_name: null,
  created_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

const account = (id: string, machineId: string, configDir: string | null, over: Partial<AiAccount> = {}): AiAccount => ({
  id,
  provider: 'claude',
  label: 'principal',
  machine_id: machineId,
  config_dir: configDir,
  created_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

/**
 * One user, their machines, their conversation and whatever is connected right now — no database, no
 * socket. `online` is what each machine's agent said in `hello`: absent means nobody is connected
 * from it, which is exactly what the registry reports as `null`.
 */
function build(opts: {
  machines?: Machine[];
  accounts?: AiAccount[];
  conversation?: { machine_id?: string | null; ai_account_id?: string | null };
  online?: Record<string, { capabilities: string[]; agent_version: string }>;
} = {}) {
  const machines = opts.machines ?? [];
  const accounts = opts.accounts ?? [];
  const online = opts.online ?? Object.fromEntries(machines.map((m) => [m.id, { capabilities: ['pty', 'claude'], agent_version: '0.5.0' }]));
  const conversation = {
    id: 'c1',
    user_id: 'u1',
    title: null,
    cli_session_id: null,
    model: null,
    machine_id: opts.conversation?.machine_id ?? null,
    ai_account_id: opts.conversation?.ai_account_id ?? null,
    review_mode: false,
    last_message_at: null,
    created_at: '',
  };
  const repos = {
    chat: { getOrCreateForUser: vi.fn(async () => conversation) },
    // Owner-scoped exactly like the repository: another user's id sees none of these rows.
    machines: { list: vi.fn(async (owner: string | null) => (owner === user.id ? machines : [])) },
    aiAccounts: { findById: vi.fn(async (id: string) => accounts.find((a) => a.id === id)) },
  };
  const agents = {
    capabilities: vi.fn((id: string) => online[id]?.capabilities ?? null),
    info: vi.fn((id: string) => (online[id] ? { agent_version: online[id].agent_version } : null)),
  };
  return { ctx: { repos, agents } as unknown as HostContext, repos, agents, conversation };
}

const kinds = (choice: HostChoice) => choice.kind;

it('runs on the only machine the user has, without asking anything', async () => {
  const only = machine('m1', 'macbook');
  const { ctx } = build({ machines: [only] });

  const choice = await resolveHost(ctx, user);

  expect(choice).toEqual({ kind: 'ready', machine: only, configDir: null });
});

it('asks which machine when there is more than one and none was chosen', async () => {
  const one = machine('m1', 'macbook');
  const two = machine('m2', 'jarvis');
  const { ctx } = build({ machines: [one, two] });

  const choice = await resolveHost(ctx, user);

  expect(choice).toEqual({ kind: 'not_chosen', machines: [one, two] });
});

it('says the chosen machine is offline instead of falling back to the container', async () => {
  const chosen = machine('m2', 'jarvis');
  const { ctx } = build({ machines: [machine('m1', 'macbook'), chosen], conversation: { machine_id: 'm2' }, online: {} });

  const choice = await resolveHost(ctx, user);

  expect(choice).toEqual({ kind: 'offline', machine: chosen });
  // The spec refuses the silent fallback: nothing here may ever read as "ready" for a machine that
  // is not answering, because that would spend the operator's account with nobody watching.
  expect(kinds(choice)).not.toBe('ready');
});

it('names the version when the chosen machine runs an agent that cannot host a chat', async () => {
  const chosen = machine('m1', 'macbook');
  const { ctx } = build({
    machines: [chosen],
    conversation: { machine_id: 'm1' },
    online: { m1: { capabilities: ['pty'], agent_version: '0.4.9' } },
  });

  const choice = await resolveHost(ctx, user);

  expect(choice).toEqual({ kind: 'agent_too_old', machine: chosen, version: '0.4.9' });
});

it('says there is no machine at all when the user has none', async () => {
  const { ctx } = build({ machines: [] });

  expect(await resolveHost(ctx, user)).toEqual({ kind: 'no_machine' });
});

it('treats a chosen machine that no longer belongs to the user as never chosen', async () => {
  const one = machine('m1', 'macbook');
  const two = machine('m2', 'jarvis');
  // A deleted machine, or one handed to someone else: either way it is absent from this user's own
  // list, and the only safe answer is to ask again — never to resolve to a machine they do not own.
  const { ctx } = build({ machines: [one, two], conversation: { machine_id: 'm-gone' } });
  expect(await resolveHost(ctx, user)).toEqual({ kind: 'not_chosen', machines: [one, two] });

  // With a single machine there is nothing to ask: the stale id is simply ignored.
  const single = build({ machines: [one], conversation: { machine_id: 'm-gone' } });
  expect(await resolveHost(single.ctx, user)).toEqual({ kind: 'ready', machine: one, configDir: null });
});

it('falls back to the machine default account when the chosen one was deleted', async () => {
  const only = machine('m1', 'macbook');
  const { ctx } = build({ machines: [only], accounts: [], conversation: { machine_id: 'm1', ai_account_id: 'acc-gone' } });

  // ON DELETE SET NULL is the database's half of this; a row still pointing at a deleted account
  // (or a read that raced the delete) must not fail the chat either.
  expect(await resolveHost(ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: null });
});

it('honours the chosen account config dir, and null means the machine default', async () => {
  const only = machine('m1', 'macbook');
  const work = account('acc1', 'm1', '/home/u/.claude-work');
  const withDir = build({ machines: [only], accounts: [work], conversation: { machine_id: 'm1', ai_account_id: 'acc1' } });
  expect(await resolveHost(withDir.ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: '/home/u/.claude-work' });

  const primary = account('acc2', 'm1', null);
  const noDir = build({ machines: [only], accounts: [primary], conversation: { machine_id: 'm1', ai_account_id: 'acc2' } });
  expect(await resolveHost(noDir.ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: null });
});

it('ignores an account that lives on another machine or is not a Claude login', async () => {
  const only = machine('m1', 'macbook');
  // Left behind by a host change: the account is a real row of this user's, but its config dir names
  // a directory on a different computer, which on this one is either absent or someone else's login.
  const elsewhere = account('acc1', 'm9', '/home/u/.claude-work');
  const moved = build({ machines: [only], accounts: [elsewhere], conversation: { machine_id: 'm1', ai_account_id: 'acc1' } });
  expect(await resolveHost(moved.ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: null });

  const chatgpt = account('acc2', 'm1', '/home/u/.codex', { provider: 'chatgpt' });
  const other = build({ machines: [only], accounts: [chatgpt], conversation: { machine_id: 'm1', ai_account_id: 'acc2' } });
  expect(await resolveHost(other.ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: null });
});

it('only ever hosts on an agent machine: a local or ssh machine is not one of the user own hosts', async () => {
  // The chat needs the agent's channel to run anything; a local machine is the server's own computer
  // and an ssh machine has no agent at all, so neither can be the "terminal geral".
  const { ctx } = build({ machines: [machine('m1', 'servidor', { type: 'local' }), machine('m2', 'vps', { type: 'ssh' })] });
  expect(await resolveHost(ctx, user)).toEqual({ kind: 'no_machine' });
});
