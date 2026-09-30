import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, AiProvider } from '../db/repositories/types.js';
import type { ProjectAi } from '../setup/schema.js';

export type { ProjectAi };

/** The providers `start_agent` can launch, and so the only ones a project may list (spec §3). */
export type AgentProvider = 'claude' | 'chatgpt';
export const AGENT_PROVIDERS: readonly AgentProvider[] = ['claude', 'chatgpt'];
export const isAgentProvider = (p: AiProvider): p is AgentProvider => (AGENT_PROVIDERS as readonly string[]).includes(p);

/**
 * The project's accounts on one machine, in priority order (spec §4): ids that no longer name one of
 * `accounts` (deleted, or out of the owner's scope) are skipped, as are accounts of other machines, of
 * another provider when one is asked for, and of a provider no agent can be started with.
 */
export function accountsOn(ai: ProjectAi, accounts: AiAccount[], machineId: string, provider?: AgentProvider): AiAccount[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return ai.accounts
    .map((id) => byId.get(id))
    .filter((a): a is AiAccount => !!a && a.machine_id === machineId && isAgentProvider(a.provider) && (provider === undefined || a.provider === provider));
}

/** The project's default model for that CLI; null = let the CLI decide (no flag). */
export function modelFor(ai: ProjectAi, provider: AiProvider): string | null {
  return isAgentProvider(provider) ? ai.models[provider] : null;
}

/**
 * Whether the model is an alias every Claude CLI resolves itself (owner decision 2026-09-30): a full id
 * may be unknown to an older CLI, which is what broke the concierge container on 2026-09-30.
 */
export function isAlias(model: string): boolean {
  return /^(opus|sonnet|haiku)(\[[a-z0-9]+\])?$/.test(model);
}

/** The project's `ai` block and the owner's accounts, read once. */
export async function loadProjectAi(repos: Pick<Repositories, 'projectSetup' | 'aiAccounts'>, projectId: string, ownerId: string | null): Promise<{ ai: ProjectAi; accounts: AiAccount[] }> {
  const [setup, accounts] = await Promise.all([repos.projectSetup.get(projectId), repos.aiAccounts.list(ownerId)]);
  return { ai: setup.data.ai, accounts };
}
