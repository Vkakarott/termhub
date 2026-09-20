import { shellQuote } from '@termhub/machine-ops';
import { config } from '../config.js';
import type { AiAccount, AiProvider, Machine, Task } from '../db/repositories/types.js';
import { sendTextToSession } from '../terminal/session-ops.js';
import { ControlError, type ControlContext } from './context.js';
import { openTab } from './terminals.js';

/** Same ceiling as one typed input: the prompt travels as a single command-line argument. */
export const PROMPT_MAX_CHARS = 4000;
const TAB_NAME_MAX = 60;

/**
 * How each provider is started (spec §4.4). The prompt goes in as the CLI's own initial-prompt argument,
 * so the session is interactive from the first turn and nothing has to guess when the TUI is "ready".
 * The account is chosen through the CLI's config-dir variable; gemini and antigravity are not wired yet.
 * No permission-bypass flag, ever.
 */
const LAUNCH: Partial<Record<AiProvider, { binary: string; configEnv: string }>> = {
  claude: { binary: 'claude', configEnv: 'CLAUDE_CONFIG_DIR' },
  chatgpt: { binary: 'codex', configEnv: 'CODEX_HOME' },
};

function launcher(provider: AiProvider): { binary: string; configEnv: string } {
  const l = LAUNCH[provider];
  if (!l) throw new ControlError('PROVIDER_UNSUPPORTED', `Iniciar um agente ${provider} ainda não é suportado; por enquanto só claude e chatgpt (Codex)`);
  return l;
}

/** The exact line typed into the tab; every value goes through `shellQuote`, so nothing in it is interpreted. */
export function launchLine(provider: AiProvider, configDir: string | null, prompt: string): string {
  const { binary, configEnv } = launcher(provider);
  const env = configDir ? `${configEnv}=${shellQuote(configDir)} ` : '';
  return `${env}${binary} ${shellQuote(prompt)}`;
}

async function accountOnMachine(ctx: ControlContext, accountId: string, machine: Machine): Promise<AiAccount> {
  const { account, machine: home } = await ctx.scoped.aiAccount(accountId);
  if (account.machine_id === machine.id) return account;
  const here = (await ctx.repos.aiAccounts.list(ctx.scope.ownerId)).filter((a) => a.machine_id === machine.id);
  const list = here.length ? here.map((a) => `${a.label} (${a.provider}, ${a.id})`).join(', ') : 'nenhuma';
  throw new ControlError('ACCOUNT_OTHER_MACHINE', `A conta "${account.label}" está na máquina ${home.name}, não em ${machine.name}. Contas em ${machine.name}: ${list}`);
}

export interface StartAgentResult {
  tab_id: string;
  tab_name: string;
  project_id: string;
  tmux_session: string | null;
  tab_url: string;
  /** the binary started (never the prompt) */
  command: string;
  task_id: string | null;
  note: string;
}

/**
 * Opens a tab in the project and starts the account's CLI there with the prompt (spec §4.4). Everything
 * that can be checked is checked before the tab exists; once it does, a failure keeps the tab and names it.
 */
export async function startAgent(
  ctx: ControlContext,
  input: { project_id: string; account_id: string; prompt: string; task_id?: string; tab_name?: string },
): Promise<StartAgentResult> {
  if (input.prompt.length > PROMPT_MAX_CHARS) throw new ControlError('PROMPT_TOO_LONG', `Prompt longo demais: ${input.prompt.length} caracteres, máximo ${PROMPT_MAX_CHARS}`);
  const { project, machine } = await ctx.scoped.project(input.project_id);
  const account = await accountOnMachine(ctx, input.account_id, machine);
  const { binary } = launcher(account.provider);
  if (!machine.capabilities.includes(binary)) {
    throw new ControlError('TOOL_MISSING', `${binary} não foi detectado em ${machine.name}. Se está instalado, atualize o termhub-agent (a detecção roda ao conectar) ou use "Detectar" na máquina.`);
  }

  let task: Task | null = null;
  if (input.task_id) {
    if (!(await ctx.can('tasks', 'update'))) throw new ControlError('FORBIDDEN', 'Vincular a tarefa precisa da permissão tasks:update na sua role');
    task = (await ctx.scoped.task(input.task_id)).task;
    if (task.project_id !== project.id) throw new ControlError('TASK_OTHER_PROJECT', `A tarefa "${task.title}" é de outro projeto`);
  }

  const line = launchLine(account.provider, account.config_dir, input.prompt);
  const name = (input.tab_name?.trim() || task?.title || `${binary} · ${account.label}`).slice(0, TAB_NAME_MAX);
  // openTab does the readiness checks (online, agent version, tab limit) and keeps the tab if the session fails.
  const tab = await openTab(ctx, { project_id: project.id, name });

  try {
    await sendTextToSession(machine, tab.tmux_session as string, line, true);
  } catch (e) {
    throw new ControlError('LAUNCH_FAILED', `A aba ${tab.tab_id} foi aberta, mas o agente não foi iniciado: ${e instanceof Error ? e.message : 'erro desconhecido'}. Veja a tela com read_screen ou feche a aba com close_tab.`);
  }
  if (task) {
    await ctx.repos.tasks.setTab(task.id, tab.tab_id);
    if (task.status !== 'doing') await ctx.repos.tasks.update(task.id, { status: 'doing' });
  }

  return {
    tab_id: tab.tab_id,
    tab_name: tab.name,
    project_id: project.id,
    tmux_session: tab.tmux_session,
    tab_url: `${config.publicUrl}/projects/${project.id}`,
    command: binary,
    task_id: task?.id ?? null,
    note: 'O agente está subindo com o prompt. Chame wait_for_state para saber quando ele terminar ou perguntar algo, e read_screen para ver a tela.',
  };
}
