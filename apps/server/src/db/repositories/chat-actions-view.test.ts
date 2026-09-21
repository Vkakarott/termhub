import { expect, it, vi } from 'vitest';
import type { ChatAction } from './chat-actions.js';
import { describeActions } from './chat-actions-view.js';

const action = (over: Partial<ChatAction>): ChatAction => ({
  id: 'a1',
  conversation_id: 'c1',
  message_id: null,
  tool: 'send_input',
  args: {},
  class: 'write',
  status: 'pending',
  idempotency_key: null,
  machine_id: null,
  project_id: null,
  tab_id: null,
  error_code: null,
  duration_ms: null,
  decided_by: null,
  decided_at: null,
  injected_at: null,
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

const tab = { id: 't1', project_id: 'p1', name: 'Terminal 2' };
const project = { id: 'p1', machine_id: 'm1', name: 'reactivando' };
const machine = { id: 'm1', name: 'macbook m3' };
const task = { id: 'tk1', project_id: 'p1', title: 'Corrigir o build' };

function fakeRepos() {
  return {
    tabs: { findByIds: vi.fn(async (ids: string[]) => (ids.includes(tab.id) ? [tab] : [])) },
    projects: { findByIds: vi.fn(async (ids: string[]) => (ids.includes(project.id) ? [project] : [])) },
    machines: { findByIds: vi.fn(async (ids: string[]) => (ids.includes(machine.id) ? [machine] : [])) },
    tasks: { findByIds: vi.fn(async (ids: string[]) => (ids.includes(task.id) ? [task] : [])) },
  } as never;
}

it('reads like a sentence about the real world: the command, the tab, the project, the machine — never a raw tool name and three ids', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, tab_id: 't1' })]);
  expect(card.summary).toBe('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3');
  expect(card.id).toBe('a1');
  expect(card.status).toBe('pending');
});

it('resolves the project and machine through the tab when the row itself only carries a tab_id', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'run_command', args: { tab_id: 't1', command: 'ls -la' }, tab_id: 't1' })]);
  expect(card.summary).toBe('rodar o comando `ls -la` na aba Terminal 2 do projeto reactivando, no macbook m3');
});

it('describes a project-only action (no tab) with the project and machine, not "na aba"', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'open_tab', args: { project_id: 'p1' }, project_id: 'p1' })]);
  expect(card.summary).toBe('abrir uma aba nova no projeto reactivando, no macbook m3');
});

it('falls back to the verb alone when nothing at all can be resolved (no tab, no project, no task id)', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'create_task', args: { project_id: 'nope', title: 'Nova tarefa' } })]);
  expect(card.summary).toBe('criar a tarefa "Nova tarefa"');
});

it('degrades gracefully when a named tab has since vanished: no crash, no dangling "na aba undefined"', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: 'gone', text: 'oi' }, tab_id: 'gone' })]);
  expect(card.summary).toBe('digitar `oi`');
});

it('names an unrecognised tool inside a sentence rather than showing it bare', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'do_something_new', args: {} })]);
  expect(card.summary).toBe('usar a ferramenta do_something_new');
});

// A task tool (add_subtasks/update_task/move_task/delete_task) never carries a machine/project/tab_id
// — its args only carry a task_id, which the gate never copies onto the row — so the task itself has
// to be resolved to say anything better than a bare id. delete_task is irreversible: this card is the
// only thing the user sees before authorising it, so approving by id alone would be approving blind.
it('names a delete_task card by the task\'s title and the project it belongs to', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'delete_task', args: { task_id: 'tk1', confirm: true }, class: 'irreversible' })]);
  expect(card.summary).toBe('apagar a tarefa "Corrigir o build" no projeto reactivando, no macbook m3');
});

it('names every other task tool by the task\'s title too', async () => {
  const repos = fakeRepos();
  const [addSubtasks] = await describeActions(repos, [action({ tool: 'add_subtasks', args: { task_id: 'tk1', subtasks: [{ title: 'x' }] } })]);
  expect(addSubtasks.summary).toBe('adicionar subtarefas à tarefa "Corrigir o build" no projeto reactivando, no macbook m3');

  const [updateTask] = await describeActions(repos, [action({ tool: 'update_task', args: { task_id: 'tk1', title: 'y' } })]);
  expect(updateTask.summary).toBe('atualizar a tarefa "Corrigir o build" no projeto reactivando, no macbook m3');

  const [moveTask] = await describeActions(repos, [action({ tool: 'move_task', args: { task_id: 'tk1', status: 'done' } })]);
  expect(moveTask.summary).toBe('mover a tarefa "Corrigir o build" no projeto reactivando, no macbook m3');
});

it('says plainly that the task no longer exists, rather than falling back to its bare id — itself useful for deciding', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'delete_task', args: { task_id: 'ja-apagada', confirm: true }, class: 'irreversible' })]);
  expect(card.summary).toBe('apagar uma tarefa que não existe mais');
  expect(card.summary).not.toContain('ja-apagada'); // the id itself is never a substitute for the fact
});

it('batches: one lookup per repository for the whole list, never one per action, and never at all when nothing to resolve', async () => {
  const repos = fakeRepos();
  await describeActions(repos, [
    action({ id: 'a1', tool: 'send_input', args: { tab_id: 't1', text: 'a' }, tab_id: 't1' }),
    action({ id: 'a2', tool: 'send_input', args: { tab_id: 't1', text: 'b' }, tab_id: 't1' }),
    action({ id: 'a3', tool: 'delete_task', args: { task_id: 'tk1', confirm: true }, class: 'irreversible' }),
  ]);
  expect(repos.tabs.findByIds).toHaveBeenCalledTimes(1);
  expect(repos.tabs.findByIds).toHaveBeenCalledWith(['t1']); // deduped, not called once per row
  expect(repos.tasks.findByIds).toHaveBeenCalledTimes(1);
  expect(repos.tasks.findByIds).toHaveBeenCalledWith(['tk1']);
  expect(repos.projects.findByIds).toHaveBeenCalledTimes(1); // fed by both the tab's and the task's project_id
  expect(repos.machines.findByIds).toHaveBeenCalledTimes(1);

  const repos2 = fakeRepos();
  await describeActions(repos2, [action({ tool: 'create_task', args: { project_id: 'nope', title: 'x' } })]);
  expect(repos2.tabs.findByIds).not.toHaveBeenCalled(); // nothing to resolve: no query at all
  expect(repos2.tasks.findByIds).not.toHaveBeenCalled();
  expect(repos2.machines.findByIds).not.toHaveBeenCalled();
});
