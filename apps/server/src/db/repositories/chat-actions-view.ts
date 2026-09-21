import type { Repositories } from './index.js';
import type { ChatAction, ChatActionClass, ChatActionStatus } from './chat-actions.js';
import type { Task } from './types.js';

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

/** The `task_id` an action's args name, if any — the four task tools below all require one, but it
 * is never copied onto the row itself (unlike machine/project/tab_id, which the gate's `targetOf`
 * does store): the sentence has to read it straight from `args`. */
const taskIdOf = (action: ChatAction): string => asString((action.args as Record<string, unknown> | null)?.task_id);

/**
 * What the sentence says was proposed, before naming where. Unknown tools (the gate classifies
 * anything it does not recognise as irreversible rather than silently allowing it) still read as a
 * sentence, naming the tool rather than showing it bare.
 *
 * A task tool (`add_subtasks`/`update_task`/`move_task`/`delete_task`) names the task by its title —
 * never its bare id — resolved from `task`. `delete_task` is in the irreversible class, so this card
 * is the only thing the user sees before authorising it: approving a deletion by id alone would be
 * approving blind. When the task has already been deleted (answered too late), that is said plainly
 * rather than falling back to a bare id, since it is itself useful information for deciding.
 */
function verbPhrase(action: ChatAction, task: Task | undefined): string {
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
      return task ? `adicionar subtarefas à tarefa "${task.title}"` : 'adicionar subtarefas a uma tarefa que não existe mais';
    case 'update_task':
      return task ? `atualizar a tarefa "${task.title}"` : 'atualizar uma tarefa que não existe mais';
    case 'move_task':
      return task ? `mover a tarefa "${task.title}"` : 'mover uma tarefa que não existe mais';
    case 'delete_task':
      return task ? `apagar a tarefa "${task.title}"` : 'apagar uma tarefa que não existe mais';
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

function summarize(action: ChatAction, task: Task | undefined, names: { tab?: string; project?: string; machine?: string }): string {
  const verb = verbPhrase(action, task);
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
 * Enriches a batch of chat actions with the sentence their card shows, resolving task/machine/project/tab
 * names in four batched lookups total — never one lookup per action, and never one per id chain
 * either. A row that only carries a tab_id (most terminal tools) still gets its project's and
 * machine's names: the tab is looked up first, and its project_id and the project's machine_id feed
 * the next two batches. A task tool (whose args carry a task_id the gate never copies onto the row)
 * is resolved the same way: the task is looked up alongside the tabs, and its project_id feeds the
 * same project batch a tab's would.
 */
export async function describeActions(repos: Repositories, actions: ChatAction[]): Promise<ChatActionCard[]> {
  const tabIds = [...new Set(actions.map((a) => a.tab_id).filter((v): v is string => v !== null))];
  const taskIds = [...new Set(actions.map(taskIdOf).filter((v) => v.length > 0))];
  const [tabs, tasks] = await Promise.all([tabIds.length ? repos.tabs.findByIds(tabIds) : [], taskIds.length ? repos.tasks.findByIds(taskIds) : []]);
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const projectIds = new Set<string>();
  for (const a of actions) if (a.project_id) projectIds.add(a.project_id);
  for (const t of tabs) projectIds.add(t.project_id);
  for (const t of tasks) projectIds.add(t.project_id);
  const projects = projectIds.size ? await repos.projects.findByIds([...projectIds]) : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const machineIds = new Set<string>();
  for (const a of actions) if (a.machine_id) machineIds.add(a.machine_id);
  for (const p of projects) machineIds.add(p.machine_id);
  const machines = machineIds.size ? await repos.machines.findByIds([...machineIds]) : [];
  const machineById = new Map(machines.map((m) => [m.id, m]));

  return actions.map((action) => {
    const tab = action.tab_id ? tabById.get(action.tab_id) : undefined;
    const task = taskById.get(taskIdOf(action));
    const project =
      (action.project_id ? projectById.get(action.project_id) : undefined) ?? (tab ? projectById.get(tab.project_id) : undefined) ?? (task ? projectById.get(task.project_id) : undefined);
    const machine = (action.machine_id ? machineById.get(action.machine_id) : undefined) ?? (project ? machineById.get(project.machine_id) : undefined);
    const summary = summarize(action, task, { tab: tab?.name, project: project?.name, machine: machine?.name });
    return toCard(action, summary);
  });
}
