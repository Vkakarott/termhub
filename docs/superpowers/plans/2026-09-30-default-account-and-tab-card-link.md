# Default login for agents and open tabs linked to cards — Implementation Plan (TER-499)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `start_agent` can run on a machine's default CLI login, an open tab can be linked to a card from the chat and from the app, and the concierge is told to do both, so Progresso shows the agents.

**Architecture:** No schema change. `config_dir = null` keeps meaning "default login"; the launch line clears an inherited config variable for it and the tools expose a `default` flag. Linking is one control operation (`linkTabTask`) shared by an MCP tool and a REST route, reusing the two repository calls `start_agent` already makes.

**Tech Stack:** Fastify + zod + Prisma repositories (`@termhub/server`), React + vitest + testing-library (`@termhub/web`).

**Spec:** `docs/superpowers/specs/2026-09-30-default-account-and-tab-card-link-design.md`

## Global Constraints

- UI copy and tool error messages in pt-BR; code, comments, commits and PR text in English.
- Routes load tabs/tasks through `scoped(repos, request)` or a control context; never `repos.*.findById` in a handler.
- Every request input is validated with zod. New route plugins are not needed: the route joins `taskTicketRoutes`.
- Nothing may assume a path for a login or a machine name. No `~/.claude` in code paths, only in copy that explains the CLI default.
- No migration, no `@termhub/agent` change, no mobile screen.
- Tests: `npx vitest run <file>` inside `apps/server` / `apps/web`. Before each push: the Docker check of `CLAUDE.md` (typecheck server, build web, build landing) plus the touched test files.
- Three PRs, merged in order, each after CI is green: PR 1 = Tasks 1–3 (+ spec and plan), PR 2 = Tasks 4–5, PR 3 = Task 6.

---

### Task 1: The default account clears the inherited config variable

**Files:**
- Modify: `apps/server/src/control/agents.ts` (`launchLine`, `resumeLine`)
- Test: `apps/server/src/control/agents.test.ts`

**Interfaces:**
- Produces: `launchLine(provider, configDir, prompt, mcp?)` and `resumeLine(configDir, sessionId, prompt, mcpTabId?)` keep their signatures; only the text for `configDir === null` changes.

- [ ] **Step 1: failing tests.** In `describe('launchLine')` and `describe('resumeLine')`, replace the expectations for a `null` config dir:

```ts
const CLEAR_CLAUDE = 'command -v unset >/dev/null 2>&1 && unset CLAUDE_CONFIG_DIR; ';
const CLEAR_CODEX = 'command -v unset >/dev/null 2>&1 && unset CODEX_HOME; ';

expect(launchLine('claude', null, 'write a spec')).toBe(`${CLEAR_CLAUDE}claude 'write a spec'`);
expect(launchLine('chatgpt', null, 'fix it')).toBe(`${CLEAR_CODEX}codex --no-alt-screen 'fix it'`);
expect(launchLine('claude', null, 'write a spec', { tabId: 'abc', url: MCP_URL })).toBe(`${CLEAR_CLAUDE}claude ${MCP_FLAGS} -- 'write a spec'`);
// codex + mcp: the token assignment stays a prefix of the binary, after the clearing
expect(launchLine('chatgpt', null, 'fix it', { tabId: 'abc', url: MCP_URL })).toMatch(/^command -v unset >\/dev\/null 2>&1 && unset CODEX_HOME; TERMHUB_MCP_TOKEN="\$\(cat /);
expect(resumeLine(null, SID, 'x')).toBe(`${CLEAR_CLAUDE}claude --resume ${SID} 'x'`);
// an account with a dir never clears anything
expect(launchLine('claude', '~/.claude-work', 'x')).not.toContain('unset');
```

Update the other exact-string expectations of a `null` dir in the file (`'is exactly the plain line without mcp'`, the `startAgent` tests of account `a2`/`a3`) the same way.

- [ ] **Step 2:** `npx vitest run src/control/agents.test.ts` → the new expectations fail.
- [ ] **Step 3: implement.**

```ts
/**
 * How the line picks the account (spec 2026-09-30 D2). With a config dir: the CLI's variable as a prefix.
 * Without one the account is the machine's default login, so a variable the tab's shell inherited must
 * not stand in for it: it is unset first. `unset` and not `env -u`, which would skip the person's alias
 * or shell function for the binary; the `command -v` guard keeps fish (no `unset`) quiet.
 */
function accountEnv(configEnv: string, configDir: string | null): { before: string; prefix: string } {
  if (configDir) return { before: '', prefix: `${configEnv}=${configDirArg(configDir)} ` };
  return { before: `command -v unset >/dev/null 2>&1 && unset ${configEnv}; `, prefix: '' };
}
```

`launchLine` and `resumeLine` build `${before}${tokenEnv?}${prefix}${binary} …`.

- [ ] **Step 4:** the file passes; also `npx vitest run src/mcp/start-agent.e2e.test.ts src/control/account-swap.test.ts` (they assert typed lines).
- [ ] **Step 5:** commit `Agents: clear an inherited config dir for the default account`.

### Task 2: `default` in `list_ai_accounts` and `find`

**Files:**
- Modify: `apps/server/src/control/inventory.ts`, `apps/server/src/mcp/tools.ts`
- Test: `apps/server/src/control/inventory.test.ts`

- [ ] **Step 1: failing tests.** `listAiAccounts` answers `default: true` for an account with `config_dir: null`, `false` for one with a dir, and never a `config_dir` key; a `find` match of kind `ai_account` carries the same `default`, other kinds do not have the key.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** add `default: a.config_dir === null` to the `listAiAccounts` map; `FindMatch.default?: boolean`, set only for `ai_account`. Descriptions: `list_ai_accounts` ends with "`default: true` marks the machine's own login for that CLI (no config dir override); false is another login of the same machine."; `start_agent` gains "Pick the account with list_ai_accounts."
- [ ] **Step 4:** `npx vitest run src/control/inventory.test.ts src/mcp` passes.
- [ ] **Step 5:** commit `MCP: say which AI account is the machine's default login`.

### Task 3: The account form asks for the default login explicitly

**Files:**
- Modify: `apps/web/src/components/AiAccountsView.tsx`
- Create: `apps/web/src/components/AiAccountsView.test.tsx`

- [ ] **Step 1: failing tests** (mock `../lib/api` and `../lib/data` as `AutoSwapSettings.test.tsx` does):
  - new account, default choice kept → `api.aiAccounts.create` called with `config_dir: null`;
  - choosing "Outro diretório de config" shows the dir field; typing `~/.claude-work` → `config_dir: '~/.claude-work'`; empty dir keeps "Adicionar" disabled;
  - editing an account with a dir opens on "Outro diretório de config" with the dir filled; one without a dir opens on "Conta padrão da máquina";
  - a card of an account without a dir shows "login padrão".
- [ ] **Step 2:** `npx vitest run src/components/AiAccountsView.test.tsx` → fail.
- [ ] **Step 3:** in `AccountForm`, a two-option radio group (`Login` label): "Conta padrão da máquina" with the hint "O login que o CLI usa quando nenhum diretório de config é definido." and "Outro diretório de config" revealing the existing input. Submit sends `config_dir: custom ? dir.trim() : null`. `AccountCard` shows `login padrão` after the machine name when `config_dir` is null. `PROVIDER_HINT.claude` reworded to match.
- [ ] **Step 4:** test file passes; `npx tsc -b` in `apps/web`.
- [ ] **Step 5:** commit `AI accounts: choose the machine's default login explicitly`.

### Task 4: `linkTabTask`, the `link_tab_task` tool and its gate

**Files:**
- Modify: `apps/server/src/control/agents.ts`, `apps/server/src/mcp/tools.ts`, `apps/server/src/chat/gate.ts`, `apps/server/src/chat/gate-runtime.ts`, `apps/server/src/db/repositories/chat-actions-view.ts`
- Test: `apps/server/src/control/agents.test.ts`, `apps/server/src/chat/gate.test.ts`, the existing tests of `gate-runtime` and `chat-actions-view`, `apps/server/src/mcp/route.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LinkTabTaskResult {
  task: TaskOut;            // after the link, with its new column/status
  tab_id: string;
  tab_name: string;
  previous_tab_id: string | null; // the tab the card pointed at before, when it was another one
  board_url: string;
}
export async function linkTabTask(ctx: ControlContext, input: { tab_id: string; task_id: string }): Promise<LinkTabTaskResult>;
```

- [ ] **Step 1: failing tests** for `linkTabTask` (same fakes as `startAgent`, plus `tabs.findById`):
  - links: `tasks.setTab('k1','t1')` then `tasks.startWork('k1')`, answers the card and `previous_tab_id: null`;
  - a subtask linked to `t-old` → `previous_tab_id: 't-old'`;
  - already linked to the same tab → `previous_tab_id: null`, still calls `startWork`;
  - card of another project → `TASK_OTHER_PROJECT` ("A tarefa "…" é de outro projeto"), nothing written;
  - a simulator tab → `TAB_NOT_TERMINAL` ("Só abas de terminal podem ser ligadas a uma tarefa");
  - without `tasks:update` → `FORBIDDEN`; another owner's tab or card → the scope's 404.
- [ ] **Step 2:** run → fail (`linkTabTask` is not exported).
- [ ] **Step 3: implement** in `control/agents.ts`; `startAgent` calls the same private helper:

```ts
/** Points the card at the tab and starts work on it (agent column, or a subtask marked doing). */
async function attachTask(ctx: ControlContext, taskId: string, tabId: string): Promise<Task | undefined> {
  await ctx.repos.tasks.setTab(taskId, tabId);
  return ctx.repos.tasks.startWork(taskId);
}
```

- [ ] **Step 4:** tool in `mcp/tools.ts` after `start_agent`:

```ts
{
  name: 'link_tab_task',
  description:
    "Link a terminal tab that is already open to a card of the same project, as start_agent does for the tab it opens: the card shows the tab (and its agent in Progresso) and moves to the project's agent column unless it already sits in a doing column; a subtask is marked doing. A card linked to another tab is re-pointed (previous_tab_id names it). Use it when an agent was started by hand in a tab; to start an agent on a card, use start_agent with task_id.",
  scope: 'tasks', resource: 'tasks', action: 'update',
  input: { tab_id: id, task_id: id },
  run: (ctx, a) => linkTabTask(ctx, a as { tab_id: string; task_id: string }),
},
```

- [ ] **Step 5: gate.** Tests first: `actionClass('link_tab_task', {})` is `'write'`; `boardGrantable('link_tab_task')` false; no standing kind; the sentence is `ligar a aba à tarefa TER-12 "Title"` (a missing card: `ligar a aba a uma tarefa que não existe mais`); an approved `link_tab_task` on a tab in `waiting_permission` whose prompt changed still runs, and on a closed tab fails with `TAB_GONE`. Then add the tool to `writeTools`, the `verbPhrase` case, and in `staleApproval` skip the permission checks for tools that type nothing (`NON_TYPING_TAB_TOOLS = new Set(['link_tab_task'])`) after the `TAB_GONE` check.
- [ ] **Step 6:** `npx vitest run src/control src/chat src/mcp src/db/repositories/chat-actions-view.test.ts` passes; typecheck.
- [ ] **Step 7:** commit `Link an open tab to a card: link_tab_task`.

### Task 5: REST route and the card editor

**Files:**
- Modify: `apps/server/src/routes/tickets.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/components/TaskEditor.tsx`, `apps/web/src/components/TasksBoard.tsx`
- Test: `apps/server/src/routes/tickets.test.ts`, `apps/web/src/components/TaskEditor.test.tsx`, `apps/web/src/components/TasksBoard.test.tsx`

**Interfaces:**
- Consumes: `linkTabTask` (Task 4).
- Produces: `POST /api/tasks/:id/link-tab` body `{ tab_id }` → `{ task: Task }` (the repository shape the board already uses, re-read through the scope); `api.tasks.linkTab(id, tabId)`; `TaskEditorProps.linkableTabs: { id: string; name: string; machine_name: string }[]`, `onLinkTab(tabId: string): void`, `onDetachTerminal(): void`.

- [ ] **Step 1: failing route tests:** 200 links and answers the task with `tab_id`; 400 on a missing `tab_id`; 404 for another owner's tab; 409 with the pt-BR message for a tab of another project (`ControlError` → `conflict`).
- [ ] **Step 2:** implement the route in `taskTicketRoutes` with `{ config: { resource: 'tasks', action: 'update' } }`, zod body `{ tab_id: z.string().min(1).max(64) }`, `linkTabTask(controlContextForRequest(repos, request), …)`.
- [ ] **Step 3: failing web tests.** `TaskEditor`: with `linkableTabs` and no `terminalHref`, "Ligar a uma aba aberta" lists the tabs as `name · machine`; choosing one and clicking "Ligar" calls `onLinkTab(id)`; with no linkable tab the control is absent; with `terminalHref`, "desligar" calls `onDetachTerminal`. `TasksBoard`: linking calls `api.tasks.linkTab` and the card shows its terminal link; only terminal tabs of this project are offered.
- [ ] **Step 4:** implement. `TasksBoard` reads `useMonitor().openTabs`, filters `project_id === projectId`, names machines through `useData().machines`; `linkTab` / `detach` call the API and `replaceTask`.
- [ ] **Step 5:** server and web test files pass; typecheck both.
- [ ] **Step 6:** commit `Board: link an open tab to a card from the card editor`.

### Task 6: The concierge's rule

**Files:**
- Modify: `apps/server/src/chat/concierge-prompt.ts`
- Test: `apps/server/src/chat/concierge-prompt.test.ts`

- [ ] **Step 1: failing test:** `ORCHESTRATOR_PROMPT` contains `start_agent with task_id`, `link_tab_task` and `default: true`; `streamedSystemPrompt('x'.repeat(4000)).length <= 8000` (the protocol's cap on `append_system_prompt`).
- [ ] **Step 2:** add the line:

```
- Agents on cards: to put an agent on a card, call start_agent with task_id — the tab is linked to the card and shows in Progresso. Pick the account with list_ai_accounts (default: true is the machine's own login). Never start an agent by typing the CLI into a tab you opened with open_tab; if a tab was started by hand for a card, link it with link_tab_task.
```

- [ ] **Step 3:** test passes; commit `Concierge: start agents on cards with start_agent and task_id`.

---

## After the merges

- Each PR: wait for "CI e Deploy", then `docker ps --filter name=termhub-app` and the two local `curl` checks of `CLAUDE.md`.
- By hand, once a default account is registered on a machine: `start_agent` with it and a `task_id`; the tab shows on the card in Progresso (needs the person's go-ahead: it opens a tab and spends account usage).
