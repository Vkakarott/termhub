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
  conversation?: { machine_id?: string | null; ai_account_id?: string | null; cli_session_id?: string | null };
  online?: Record<string, { capabilities: string[]; agent_version: string }>;
} = {}) {
  const machines = opts.machines ?? [];
  const accounts = opts.accounts ?? [];
  const online = opts.online ?? Object.fromEntries(machines.map((m) => [m.id, { capabilities: ['pty', 'claude'], agent_version: '0.5.0' }]));
  const conversation = {
    id: 'c1',
    user_id: 'u1',
    title: null,
    cli_session_id: opts.conversation?.cli_session_id ?? null,
    model: null,
    machine_id: opts.conversation?.machine_id ?? null,
    ai_account_id: opts.conversation?.ai_account_id ?? null,
    review_mode: false,
    last_message_at: null,
    created_at: '',
  };
  const repos = {
    chat: { getOrCreateForUser: vi.fn(async () => conversation) },
    // Owner-scoped exactly like the repository: `null` is the unfiltered admin read, and an owner id
    // sees only their own rows — so a machine of someone else's can be in this fixture and still be
    // absent from what `resolveHost` is given.
    machines: { list: vi.fn(async (owner: string | null) => (owner === null ? machines : machines.filter((m) => m.owner_id === owner))) },
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

  expect(choice).toEqual({ kind: 'ready', machine: only, configDir: null, account: { kind: 'default' }, sessionAtStake: false });
});

it('asks which machine when there is more than one and none was chosen', async () => {
  const one = machine('m1', 'macbook');
  const two = machine('m2', 'jarvis');
  const { ctx } = build({ machines: [one, two] });

  const choice = await resolveHost(ctx, user);

  expect(choice).toEqual({ kind: 'not_chosen', machines: [one, two], sessionAtStake: false });
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
  expect(await resolveHost(ctx, user)).toEqual({ kind: 'not_chosen', machines: [one, two], sessionAtStake: false });

  // With a single machine there is nothing to ask: the stale id is simply ignored.
  const single = build({ machines: [one], conversation: { machine_id: 'm-gone' } });
  expect(await resolveHost(single.ctx, user)).toEqual({ kind: 'ready', machine: one, configDir: null, account: { kind: 'default' }, sessionAtStake: false });
});

it('says a session is at stake when the conversation already ran and has no machine chosen', async () => {
  const one = machine('m1', 'macbook');
  const two = machine('m2', 'jarvis');

  // Someone unenrolled the machine this conversation was running on: the FK nulled `machine_id` while
  // `cli_session_id` stayed, so the session now points at a config dir on a machine that is gone. The
  // same shape happens without any deletion: a conversation that ran while there was one machine never
  // stored it, and a second machine turns it into a choice. Either way, picking a machine that is not
  // the one holding that session throws the model's memory away — and the spec says the person hears
  // that *before* the change, so the state travels to the screen instead of being guessed there.
  const gone = build({ machines: [one, two], conversation: { machine_id: null, cli_session_id: 'sess-1' } });
  expect(await resolveHost(gone.ctx, user)).toEqual({ kind: 'not_chosen', machines: [one, two], sessionAtStake: true });

  // A conversation that never ran has nothing to lose, and must not be warned: a warning that is
  // usually false is a warning nobody reads.
  const fresh = build({ machines: [one, two], conversation: { machine_id: null, cli_session_id: null } });
  expect(await resolveHost(fresh.ctx, user)).toEqual({ kind: 'not_chosen', machines: [one, two], sessionAtStake: false });
});

it('says a session is at stake on the machine it picks for the person, instead of moving the host in silence', async () => {
  const survivor = machine('m2', 'jarvis');
  // Two machines, a long conversation on the other one, and that one unenrolled: the foreign key nulled
  // `machine_id` while `cli_session_id` stayed, the candidates are now just this one, and the next
  // message resumes a session that lives in a config dir on a machine that is gone — it fails and the
  // server restarts on a fresh session, so the model's memory goes with no word said. With three
  // machines the very same deletion would have produced `not_chosen` and its warning.
  const moved = build({ machines: [survivor], conversation: { machine_id: null, cli_session_id: 'sess-1' } });
  expect(await resolveHost(moved.ctx, user)).toEqual({ kind: 'ready', machine: survivor, configDir: null, account: { kind: 'default' }, sessionAtStake: true });

  // …and not a word on the ordinary single-machine conversation: its session is on the machine that is
  // about to answer (a run pins the host it used, so a conversation with a session names one), and a
  // warning that is usually false is one nobody reads.
  const normal = build({ machines: [survivor], conversation: { machine_id: 'm2', cli_session_id: 'sess-1' } });
  expect(await resolveHost(normal.ctx, user)).toEqual({ kind: 'ready', machine: survivor, configDir: null, account: { kind: 'default' }, sessionAtStake: false });

  // Nor on a conversation that never ran: there is no memory to lose by picking its only machine.
  const fresh = build({ machines: [survivor], conversation: { machine_id: null, cli_session_id: null } });
  expect(await resolveHost(fresh.ctx, user)).toEqual({ kind: 'ready', machine: survivor, configDir: null, account: { kind: 'default' }, sessionAtStake: false });
});

it('never chooses a machine that belongs to someone else, even when the conversation names it', async () => {
  const mine = machine('m1', 'macbook');
  const theirs = machine('m2', 'jarvis', { owner_id: 'u2' });
  const { ctx, repos } = build({ machines: [mine, theirs], conversation: { machine_id: 'm2' } });

  // The row really exists, and a read that forgot to scope would hand it straight over…
  expect(await repos.machines.list(null)).toContainEqual(theirs);
  // …but the candidates are this user's own machines, so their own is what runs — and the machine id
  // stored on the conversation is never enough on its own to make a host of it.
  expect(await resolveHost(ctx, user)).toEqual({ kind: 'ready', machine: mine, configDir: null, account: { kind: 'default' }, sessionAtStake: false });
  expect(repos.machines.list).toHaveBeenCalledWith(user.id);

  // With more than one machine of their own the same foreign id asks again, listing only their own.
  const two = machine('m3', 'servidor');
  const several = build({ machines: [mine, theirs, two], conversation: { machine_id: 'm2' } });
  expect(await resolveHost(several.ctx, user)).toEqual({ kind: 'not_chosen', machines: [mine, two], sessionAtStake: false });
});

it('falls back to the machine default account when the chosen one was deleted, and says the choice was lost', async () => {
  const only = machine('m1', 'macbook');
  const { ctx } = build({ machines: [only], accounts: [], conversation: { machine_id: 'm1', ai_account_id: 'acc-gone' } });

  // ON DELETE SET NULL is the database's half of this; a row still pointing at a deleted account
  // (or a read that raced the delete) must not fail the chat either. It must not pass for "nothing was
  // chosen" either: the run degraded to another login than the one the user picked, and the screen
  // says so (Task 6).
  expect(await resolveHost(ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: null, account: { kind: 'lost' }, sessionAtStake: false });
});

it('honours the chosen account config dir, names it, and null means the machine default', async () => {
  const only = machine('m1', 'macbook');
  const work = account('acc1', 'm1', '/home/u/.claude-work', { label: 'trabalho' });
  const withDir = build({ machines: [only], accounts: [work], conversation: { machine_id: 'm1', ai_account_id: 'acc1' } });
  // The label travels with the choice: the header has to name the account that is running the
  // conversation, and a config dir path is not a name anyone recognises.
  expect(await resolveHost(withDir.ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: '/home/u/.claude-work', account: { kind: 'chosen', id: 'acc1', label: 'trabalho' }, sessionAtStake: false });

  const primary = account('acc2', 'm1', null, { label: 'principal' });
  const noDir = build({ machines: [only], accounts: [primary], conversation: { machine_id: 'm1', ai_account_id: 'acc2' } });
  // An account row with no config dir *is* the machine's default login — still the account the user
  // chose, so it is `chosen`, never `lost`.
  expect(await resolveHost(noDir.ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: null, account: { kind: 'chosen', id: 'acc2', label: 'principal' }, sessionAtStake: false });
});

it('ignores an account that lives on another machine or is not a Claude login, and reports it as lost', async () => {
  const only = machine('m1', 'macbook');
  // Left behind by a host change: the account is a real row of this user's, but its config dir names
  // a directory on a different computer, which on this one is either absent or someone else's login.
  const elsewhere = account('acc1', 'm9', '/home/u/.claude-work');
  const moved = build({ machines: [only], accounts: [elsewhere], conversation: { machine_id: 'm1', ai_account_id: 'acc1' } });
  expect(await resolveHost(moved.ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: null, account: { kind: 'lost' }, sessionAtStake: false });

  const chatgpt = account('acc2', 'm1', '/home/u/.codex', { provider: 'chatgpt' });
  const other = build({ machines: [only], accounts: [chatgpt], conversation: { machine_id: 'm1', ai_account_id: 'acc2' } });
  expect(await resolveHost(other.ctx, user)).toEqual({ kind: 'ready', machine: only, configDir: null, account: { kind: 'lost' }, sessionAtStake: false });
});

it('only ever hosts on an agent machine: a local or ssh machine is not one of the user own hosts', async () => {
  // The chat needs the agent's channel to run anything; a local machine is the server's own computer
  // and an ssh machine has no agent at all, so neither can be the "terminal geral".
  const { ctx } = build({ machines: [machine('m1', 'servidor', { type: 'local' }), machine('m2', 'vps', { type: 'ssh' })] });
  expect(await resolveHost(ctx, user)).toEqual({ kind: 'no_machine' });
});
