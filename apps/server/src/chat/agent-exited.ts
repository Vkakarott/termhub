import type { FastifyBaseLogger } from 'fastify';
import { isClaudeSessionId } from '@termhub/machine-ops';
import { swapPreferences } from '../control/account-swap.js';
import { continueLine, resumeLine } from '../control/agents.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { failureLabel } from './service.js';
import type { SuggestionPayload } from './tab-question-payload.js';
import { closeTabQuestions, publishTabQuestions } from './tab-questions.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** The tab's `state_text` once its agent is found gone (TER-643): what the monitor and `list_tabs` show. */
export const AGENT_EXITED_TEXT = 'Agente encerrado sem terminar o turno';

/** What a resumed Claude session is told first. */
export const EXITED_RESUME_PROMPT = 'O processo anterior desta sessão foi encerrado no meio do trabalho. Continue a tarefa de onde parou.';

/**
 * The line that brings the tab's agent back, under the account it ran with: a Claude session whose id the
 * hooks reported resumes by id (with the tab's memory MCP while its token lives, and the project's model);
 * otherwise the CLI's own "last session" (`claude --continue`, `codex resume --last`).
 */
export async function resumeCommandFor(repos: Repositories, tab: Tab, machine: Machine): Promise<string> {
  const codex = tab.state_tool === 'codex';
  const account = tab.ai_account_id ? (await repos.aiAccounts.list(machine.owner_id)).find((a) => a.id === tab.ai_account_id && a.machine_id === machine.id) : undefined;
  const configDir = account?.config_dir ?? null;
  if (codex || !tab.agent_session_id || !isClaudeSessionId(tab.agent_session_id)) return continueLine(codex ? 'chatgpt' : 'claude', configDir);
  const [hasTabMcp, prefs] = await Promise.all([repos.apiTokens.hasLiveForTab(tab.id).catch(() => false), swapPreferences(repos, tab, machine).catch(() => ({ model: undefined }))]);
  return resumeLine(configDir, tab.agent_session_id, EXITED_RESUME_PROMPT, hasTabMcp ? tab.id : null, prefs.model);
}

/**
 * The tab's agent exited without a hook (TER-643): the sweeper found the pane back at its shell and set
 * the tab `idle`. A card in the project owner's most recently active conversation says so and offers the
 * line that resumes it (a suggestion card: editable, Enviar / Dispensar); opening it expires whatever the
 * dead process had left open. `lastAt` is the tab's last state change before the exit. A project nobody
 * chats in gets no card. Never throws; logs ids only.
 */
export async function notifyAgentExited(repos: Repositories, log: Log, tab: Tab, machine: Machine, lastAt: string | null): Promise<void> {
  try {
    const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
    const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
    if (!conversation) {
      await closeTabQuestions(repos, tab.id, 'expired');
      return;
    }
    const payload: SuggestionPayload = { text: await resumeCommandFor(repos, tab, machine), context: null, exited: true, last_at: lastAt, ...(tab.state_tool === 'codex' ? { agent: 'codex' as const } : {}) };
    const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation.id, kind: 'suggestion', payload, tool_use_id: null, agent_id: null });
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    if (question) await publishTabQuestions(repos, 'tab_question', [question]);
    log.info({ tabId: tab.id, machineId: machine.id, tabQuestionId: question?.id ?? null, closed: closed.length }, 'agent exited card opened');
  } catch (err) {
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'agent exited card failed');
  }
}
