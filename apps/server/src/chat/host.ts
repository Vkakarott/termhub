import { CAPABILITY_CLAUDE } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, User } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';

/**
 * The slice of the agent registry this reads: what the machine's agent said when it connected, or
 * `null` when nobody is connected from it (see `AgentRegistry.capabilities`). Note these are the
 * *protocol* capabilities from `hello`, not `Machine.capabilities` — which is the list of tools the
 * status detection found on the machine and says nothing about what its agent understands.
 */
export interface HostAgents {
  capabilities(machineId: string): string[] | null;
  info(machineId: string): { agent_version: string } | null;
}

/** Everything `resolveHost` needs, so it can be exercised without a server: the owner-scoped reads
 *  and the live registry, both as narrow interfaces. */
export interface HostContext {
  repos: Pick<Repositories, 'chat' | 'machines' | 'aiAccounts'>;
  agents: HostAgents;
}

/**
 * Which Claude login on the host the conversation runs on, in the words the screen needs — the second
 * half of the pair, next to `configDir`, which is the same answer in the words the runner needs.
 *
 * `lost` is the one that had to be a state instead of a null: an account the user chose that cannot be
 * used here (deleted, left behind on another machine by a host change, or not a Claude login) silently
 * degrades the run to the machine's own default login. That is the right thing to run, and the wrong
 * thing to do quietly — so it is told apart from `default`, where nothing was ever chosen and there is
 * nothing to say.
 */
export type HostAccount = { kind: 'chosen'; id: string; label: string } | { kind: 'default' } | { kind: 'lost' };

/**
 * Which machine and which account run this user's conversation — the "terminal geral" of spec §3 —
 * or why none can. Every variant carries what its message needs (the machine's name, the machines to
 * choose between, the agent's version), because the person must read what actually happened and not a
 * generic failure; Task 6 renders them.
 */
export type HostChoice =
  | { kind: 'ready'; machine: Machine; configDir: string | null; account: HostAccount }
  | { kind: 'no_machine' }
  /**
   * `sessionAtStake` is what tells the two ways of reaching this apart, because they deserve different
   * screens: a conversation that never ran has nothing to lose by picking a machine, while one that
   * already ran holds a `cli_session_id` in the config dir of a machine this conversation no longer
   * names (unenrolled, or never stored because there was only one candidate at the time). Picking a
   * machine that is not the one holding that session throws the model's memory away, and `setHost`
   * cannot see it coming — the stored machine is already null, so it has nothing to compare and keeps
   * the id. Spec §3 says the person hears that before the change, so the state travels instead of
   * being guessed in the browser. Only ever true when something really is at stake: a warning that is
   * usually false teaches people to click past the one that matters.
   */
  | { kind: 'not_chosen'; machines: Machine[]; sessionAtStake: boolean }
  | { kind: 'offline'; machine: Machine }
  | { kind: 'agent_too_old'; machine: Machine; version: string };

/** Anything but a host that can run right now. */
export type HostProblem = Exclude<HostChoice, { kind: 'ready' }>;

/**
 * Resolves the host pair for this user's conversation. It reads and never writes: a stale choice is
 * reported as "choose again", never silently rewritten, so two runs racing cannot disagree about
 * which machine answered.
 *
 * The candidates are the user's **own agent machines**: only an agent holds the connection a run
 * travels on (a local machine is the server's own computer, an ssh machine has no agent), and the
 * list is owner-scoped in SQL, so a chosen id that belongs to someone else is simply not in it. That
 * is what makes `ready` unreachable for a machine the user does not own.
 */
export async function resolveHost(ctx: HostContext, user: User): Promise<HostChoice> {
  const [conversation, machines] = await Promise.all([ctx.repos.chat.getOrCreateForUser(user.id), ctx.repos.machines.list(user.id)]);
  const candidates = machines.filter((m) => m.type === 'agent');
  if (candidates.length === 0) return { kind: 'no_machine' };

  const chosen = conversation.machine_id === null ? undefined : candidates.find((m) => m.id === conversation.machine_id);
  // A chosen machine that is gone (deleted, or no longer this user's) behaves exactly as if nothing
  // had ever been chosen: with one machine there is nothing to ask, with several the user picks.
  const machine = chosen ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!machine) return { kind: 'not_chosen', machines: candidates, sessionAtStake: conversation.cli_session_id !== null };

  const capabilities = ctx.agents.capabilities(machine.id);
  // Offline, or connected but still before `hello`: the same thing to a message that has to be sent
  // now. Never a fallback to the operator's container (spec §3) — that would spend the operator's
  // credit with nobody watching and hide that the user's machine was not involved.
  if (capabilities === null) return { kind: 'offline', machine };
  // The same capability `agentRunner` requires before it opens a channel; checked here so the person
  // reads one sentence *before* a run is attempted, instead of a failed answer afterwards.
  if (!capabilities.includes(CAPABILITY_CLAUDE)) {
    // The version comes from the live `hello` (an agent that is connected always has one); the stored
    // one is the fallback, and an empty string means the agent never said — the message then drops
    // the version rather than inventing one.
    return { kind: 'agent_too_old', machine, version: ctx.agents.info(machine.id)?.agent_version ?? machine.agent_version ?? '' };
  }

  return { kind: 'ready', machine, ...(await accountFor(ctx, conversation.ai_account_id, machine)) };
}

/**
 * The login the run uses: the `CLAUDE_CONFIG_DIR` it gets (`null` = the machine's own default login),
 * and which account that is.
 *
 * The machine's default login is the answer to every doubt, never a failure: the account row was
 * deleted (the column is `ON DELETE SET NULL`, but a read can also race the delete), it belongs to
 * another machine (left behind by a host change, so its path names a directory that on this host is
 * absent or someone else's login), or it is not a Claude account at all. Guessing another of the
 * machine's accounts would run the conversation on a login the user did not pick. Every one of those
 * comes back as `lost`, so the screen can say the chosen account is not the one running — the silent
 * half of this fallback was the whole complaint.
 */
async function accountFor(ctx: HostContext, accountId: string | null, machine: Machine): Promise<{ configDir: string | null; account: HostAccount }> {
  if (accountId === null) return { configDir: null, account: { kind: 'default' } };
  const account = await ctx.repos.aiAccounts.findById(accountId);
  if (!account || account.machine_id !== machine.id || account.provider !== 'claude') return { configDir: null, account: { kind: 'lost' } };
  // A Claude account of this machine with no config dir is the machine's default login, chosen on
  // purpose: still the account the user picked, so never `lost`.
  return { configDir: account.config_dir, account: { kind: 'chosen', id: account.id, label: account.label } };
}

/**
 * `(versão 0.4.9)`, or nothing at all when the agent never said which one it is.
 *
 * Deliberately duplicated in `apps/web/src/components/chat/ChatHost.tsx`, which renders the same note
 * in the browser: this is one string on either side of a process boundary, and a shared package for it
 * would cost more than it saves. If the shape of the note changes, change both — they are not wired
 * together and nothing will fail if one is forgotten.
 */
const versionNote = (version: string): string => (version ? ` (versão ${version})` : '');

/**
 * What a host that cannot run says to the person who just sent a message. Thrown before any
 * assistant row is written, so the browser shows this sentence instead of an empty bubble waiting for
 * an answer nobody is producing; the code is what the screen keys its own, longer explanation and its
 * button off (Task 6).
 *
 * 409, not 503: none of these is the server being unavailable — each is a state of the user's own
 * account that retrying does not change and that they can act on.
 */
export function hostFailure(problem: HostProblem): HttpError {
  switch (problem.kind) {
    case 'no_machine':
      return new HttpError(409, 'O chat roda em uma máquina sua. Cadastre uma máquina com o agente do termhub para conversar com o concierge.', 'CHAT_NO_MACHINE');
    case 'not_chosen':
      return new HttpError(409, 'Escolha em qual das suas máquinas o chat vai rodar.', 'CHAT_HOST_NOT_CHOSEN');
    case 'offline':
      return new HttpError(409, `A máquina ${problem.machine.name} está offline. Ligue-a ou escolha outra máquina para o chat.`, 'CHAT_HOST_OFFLINE');
    case 'agent_too_old':
      return new HttpError(
        409,
        `O agente da máquina ${problem.machine.name}${versionNote(problem.version)} ainda não sabe rodar o chat. Atualize o agente e tente de novo.`,
        'CHAT_AGENT_TOO_OLD',
      );
  }
}
