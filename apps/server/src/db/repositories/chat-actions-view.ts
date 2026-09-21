import type { Repositories } from './index.js';
import type { ChatAction, ChatActionClass, ChatActionStatus } from './chat-actions.js';

/**
 * The trimmed, human-facing shape of a chat action: what the card needs to read like a sentence
 * about the real world ("digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook
 * m3"), never a tool name and three ids. Shared verbatim by `GET /api/chat`'s trail and the
 * `confirmation` bus event, so the browser never resolves a name or guesses a sentence itself.
 */
export interface ChatActionCard {
  id: string;
  tool: string;
  args: unknown;
  class: ChatActionClass;
  status: ChatActionStatus;
  machine_id: string | null;
  project_id: string | null;
  tab_id: string | null;
  summary: string;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What the sentence says was proposed, before naming where. Unknown tools (the gate classifies
 * anything it does not recognise as irreversible rather than silently allowing it) still read as a
 * sentence, naming the tool rather than showing it bare. */
function verbPhrase(action: ChatAction): string {
  const args = (action.args ?? {}) as Record<string, unknown>;
  switch (action.tool) {
    case 'send_input':
      return `digitar \`${asString(args.text)}\``;
    case 'run_command':
      return `rodar o comando \`${asString(args.command)}\``;
    case 'send_key':
      return `enviar a tecla \`${asString(args.key)}\``;
    case 'open_tab':
      return 'abrir uma aba nova';
    case 'close_tab':
      return 'fechar a aba';
    case 'start_agent':
      return `iniciar um agente com o prompt "${asString(args.prompt)}"`;
    case 'create_task':
      return `criar a tarefa "${asString(args.title)}"`;
    case 'add_subtasks':
      return 'adicionar subtarefas a uma tarefa';
    case 'update_task':
      return 'atualizar uma tarefa';
    case 'move_task':
      return 'mover uma tarefa';
    case 'delete_task':
      return 'apagar uma tarefa';
    default:
      return `usar a ferramenta ${action.tool}`;
  }
}

/** Where the sentence says it happens, from the resolved names — never from raw ids. Reads
 * "na aba X do projeto Y, no Z" when all three are known, degrading gracefully as fewer are. */
function targetPhrase(names: { tab?: string; project?: string; machine?: string }): string {
  const parts: string[] = [];
  if (names.tab) parts.push(`na aba ${names.tab}`);
  if (names.project) parts.push(`${names.tab ? 'do' : 'no'} projeto ${names.project}`);
  const place = parts.join(' ');
  if (!names.machine) return place;
  return place ? `${place}, no ${names.machine}` : `no ${names.machine}`;
}

function summarize(action: ChatAction, names: { tab?: string; project?: string; machine?: string }): string {
  const verb = verbPhrase(action);
  const where = targetPhrase(names);
  return where ? `${verb} ${where}` : verb;
}

const toCard = (action: ChatAction, summary: string): ChatActionCard => ({
  id: action.id,
  tool: action.tool,
  args: action.args,
  class: action.class,
  status: action.status,
  machine_id: action.machine_id,
  project_id: action.project_id,
  tab_id: action.tab_id,
  summary,
});

/**
 * Enriches a batch of chat actions with the sentence their card shows, resolving machine/project/tab
 * names in three batched lookups total — never one lookup per action, and never one per id chain
 * either. A row that only carries a tab_id (most terminal tools) still gets its project's and
 * machine's names: the tab is looked up first, and its project_id and the project's machine_id feed
 * the next two batches.
 */
export async function describeActions(repos: Repositories, actions: ChatAction[]): Promise<ChatActionCard[]> {
  const tabIds = [...new Set(actions.map((a) => a.tab_id).filter((v): v is string => v !== null))];
  const tabs = tabIds.length ? await repos.tabs.findByIds(tabIds) : [];
  const tabById = new Map(tabs.map((t) => [t.id, t]));

  const projectIds = new Set<string>();
  for (const a of actions) if (a.project_id) projectIds.add(a.project_id);
  for (const t of tabs) projectIds.add(t.project_id);
  const projects = projectIds.size ? await repos.projects.findByIds([...projectIds]) : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const machineIds = new Set<string>();
  for (const a of actions) if (a.machine_id) machineIds.add(a.machine_id);
  for (const p of projects) machineIds.add(p.machine_id);
  const machines = machineIds.size ? await repos.machines.findByIds([...machineIds]) : [];
  const machineById = new Map(machines.map((m) => [m.id, m]));

  return actions.map((action) => {
    const tab = action.tab_id ? tabById.get(action.tab_id) : undefined;
    const project = (action.project_id ? projectById.get(action.project_id) : undefined) ?? (tab ? projectById.get(tab.project_id) : undefined);
    const machine = (action.machine_id ? machineById.get(action.machine_id) : undefined) ?? (project ? machineById.get(project.machine_id) : undefined);
    const summary = summarize(action, { tab: tab?.name, project: project?.name, machine: machine?.name });
    return toCard(action, summary);
  });
}
