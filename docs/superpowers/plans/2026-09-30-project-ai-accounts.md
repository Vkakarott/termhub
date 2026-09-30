# Project AI accounts, priority and default model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project's setup lists its AI accounts in priority order and a default model per CLI; `start_agent`, the tab account swap and the project chat read it, passing the model to the CLI explicitly.

**Architecture:** A new `ai` block in the zod-validated `project_setups.data` JSON (no migration), a pure helper module `apps/server/src/ai/project-accounts.ts`, dedicated setup endpoints for web and mobile, and small hooks in the seams TER-587 (`swapPreferences`) and TER-588 (`fallbackCandidates`, `LimitFallback`) left for this card. A usage-limit card reuses `tab_questions` with its own events so installed phone apps keep parsing.

**Tech Stack:** Fastify + zod + Prisma (server), vitest, React + Vite (web), Expo / React Native (mobile), `packages/mobile-api` contract.

**Spec:** `docs/superpowers/specs/2026-09-30-project-ai-accounts-design.md`

## Global Constraints

- UI copy in pt-BR; code, comments, commits, PR in English.
- No project configuration ⇒ behaviour identical to today (every path must fall back).
- Every value typed into a shell goes through `shellQuote`.
- Routes never import Prisma; AI accounts, projects, machines are loaded through `scoped(repos, request)`.
- Model format: `^[A-Za-z0-9._:\[\]-]{1,100}$`; aliases `opus | sonnet | haiku` (optional `[...]` suffix).
- Swap threshold stays `SWAP_MAX_UTILIZATION = 90`.
- A project never overrides `machines.claude_auto_swap = false`.
- Mobile contract: new card travels on new events (`tab_limit`, `tab_limit_closed`) and a new list (`tab_limits`); `tabQuestionSchema` is not extended.
- Verify with Docker `node:20` (CLAUDE.md), never on the host.

## Review Focus

- A setup listing an account that was later deleted or whose machine was unlinked: start_agent, swap and chat ignore it, never 500.
- A web form loaded before the deploy saving the whole setup: the `ai` block stored by the phone survives.
- A project whose accounts are all on another machine than the chat host: the chat uses today's manual host account.
- A model string with shell metacharacters submitted past the UI (API call): refused by zod and quoted anyway in the line.
- An installed phone app older than this release receiving a usage-limit card: it keeps parsing `tab_question*` events and the chat payload.

---

### Task 1: `ai` setup block and helper module

**Files:**
- Modify: `apps/server/src/setup/schema.ts`
- Create: `apps/server/src/ai/project-accounts.ts`, `apps/server/src/ai/project-accounts.test.ts`
- Test: `apps/server/src/setup/schema.test.ts` (create if absent)

**Interfaces — Produces:**
```ts
// setup/schema.ts
export const MODEL_RE = /^[A-Za-z0-9._:\[\]-]{1,100}$/;
export const aiSchema: z.ZodObject<{ accounts: string[] (max 20, unique); models: { claude: string|null; chatgpt: string|null } }>;
setupSchema.ai (default { accounts: [], models: { claude: null, chatgpt: null } })
// ai/project-accounts.ts
export type ProjectAi = z.infer<typeof aiSchema>;
export type AgentProvider = 'claude' | 'chatgpt';
export function accountsOn(ai: ProjectAi, accounts: AiAccount[], machineId: string, provider?: AgentProvider): AiAccount[];
export function modelFor(ai: ProjectAi, provider: AiProvider): string | null;
export function isAlias(model: string): boolean;
export async function loadProjectAi(repos: Pick<Repositories,'projectSetup'|'aiAccounts'>, projectId: string, ownerId: string | null): Promise<{ ai: ProjectAi; accounts: AiAccount[] }>;
```

- [ ] Step 1: tests — schema default fills `ai`; duplicate ids refused (`superRefine` message `Conta repetida`); 21 ids refused; `sonnet[1m]`, `claude-opus-5-5`, `gpt-5-codex` accepted, `opus; rm -rf` refused; a stored setup without `ai` normalises to the default.
- [ ] Step 2: tests — `accountsOn` keeps priority order, drops unknown ids, filters by machine and provider; `modelFor` returns `null` for gemini; `isAlias('opus')`, `isAlias('sonnet[1m]')` true, `isAlias('claude-opus-5-5')` false.
- [ ] Step 3: implement (`aiSchema` added to `setupSchema`; duplicates checked inside `aiSchema` with `superRefine`, so `normalizeSetup`'s field-by-field fallback keeps working).
- [ ] Step 4: run `npx vitest run src/ai/project-accounts.test.ts src/setup` (Docker), PASS.
- [ ] Step 5: commit `Setup: ai block with project accounts and default models`.

### Task 2: Setup AI endpoints (web and mobile) and full PUT keeps `ai`

**Files:**
- Modify: `apps/server/src/routes/setup.ts`, the mobile routes file that serves `/api/m/v1/projects` (or `m-chat.ts` neighbour; create `routes/m-project-ai.ts` registered like the other `m-*` routes), `packages/mobile-api/src/` (new `project-ai.ts`, exported from index)
- Test: `apps/server/src/routes/setup.test.ts` (extend or create with the existing route-test harness)

**Interfaces — Produces:**
```ts
// response of GET/PUT /projects/:id/setup/ai and /api/m/v1/projects/:id/ai
{ ai: ProjectAi; available: { id; label; provider: 'claude'|'chatgpt'; machine_id; machine_name; default: boolean }[] }
// packages/mobile-api
export const projectAiSchema, projectAiResponse, projectAiBody
```

- [ ] Step 1: tests — GET lists only Claude/Codex accounts of linked machines, owner-scoped; PUT with another owner's account → 400 `Conta de IA inexistente`; account on an unlinked machine → 400 `A conta X está numa máquina que não está ligada ao projeto`; gemini account → 400; PUT saves only `ai`, leaving other blocks untouched; full `PUT /setup` with a body lacking or carrying `ai` keeps the stored `ai`.
- [ ] Step 2: implement shared `describeProjectAi(repos, scope, projectId)` and `saveProjectAi(...)` in `apps/server/src/setup/project-ai.ts`; both routes call them.
- [ ] Step 3: tests PASS; mobile-api typecheck/test PASS.
- [ ] Step 4: commit `Setup: endpoints for the project's AI accounts and models`.

### Task 3: `--model` in launch/resume lines and priority in `rankCandidates`

**Files:**
- Modify: `apps/server/src/control/agents.ts` (`launchLine`, `resumeLine`), `apps/server/src/control/account-swap.ts` (`rankCandidates` only)
- Test: `apps/server/src/control/agents.test.ts`, `apps/server/src/control/account-swap.test.ts`

**Interfaces — Produces:**
```ts
launchLine(provider, configDir, prompt, mcp?: {...}|null, model?: string|null): string   // claude: `claude --model 'm' …`, codex: `codex --no-alt-screen -m 'm' …`
resumeLine(configDir, sessionId, prompt, mcpTabId?: string|null, model?: string|null): string // `claude --model 'm' --resume …`
rankCandidates(accounts, usage, opts: { explicit: boolean; priority?: string[] }): AiAccount[]
```

- [ ] Step 1: tests — model flag placed right after the binary (and after `--no-alt-screen` for codex), quoted; absent/null model gives exactly today's line; a model that fails `MODEL_RE` throws `ControlError('INVALID_MODEL')`; with `priority` the order is the priority order (not usage), ≥90 dropped unless explicit, unknown usage kept in place, ids not in priority dropped.
- [ ] Step 2: implement.
- [ ] Step 3: PASS; commit `Agents: pass the model to the CLI; swap ranking by project priority`.

### Task 4: `start_agent` reads the project configuration

**Files:**
- Modify: `apps/server/src/control/agents.ts` (`startAgent`), `apps/server/src/mcp/tools.ts` (start_agent input/description), `apps/server/src/chat/concierge-prompt.ts`
- Test: `apps/server/src/control/agents.test.ts`

**Behaviour:** `account_id` optional, `model` optional. Resolution:
1. `machine_id` given or single linked machine → that machine; several machines and no `machine_id` → if the project lists accounts, the machine of the first available listed account (usage < 90 or unknown, `getAccountUsage(a, machine, false)`), else today's `MACHINE_REQUIRED`.
2. `account_id` given → today's check. Else listed accounts on that machine (claude/chatgpt) → first available, else first listed with `note` "está no limite de uso". Else `ControlError('ACCOUNT_REQUIRED', 'Escolha a conta (account_id): o projeto não tem contas configuradas em <machine>. Contas lá: …')`.
3. model = `input.model ?? modelFor(ai, account.provider)`.
Result gains `account: { id, label }`, `model: string | null`, `warning?: string` (non-alias model).

- [ ] Step 1: tests — configured project, no account_id → first available account's line; first at 95% → second; all ≥90 → first + note; no config, no account_id → ACCOUNT_REQUIRED listing accounts; two machines, no machine_id, configured → machine of first available; explicit model beats project model; project model used when none given; non-alias model → warning; existing result `toEqual` updated with `account`/`model`.
- [ ] Step 2: implement (usage via `getAccountUsage` injected through a module mock in tests).
- [ ] Step 3: tool schema: `account_id: id.optional()`, `model: z.string().regex(MODEL_RE).optional()`; description mentions project defaults; concierge prompt line: "Num projeto com contas configuradas no setup, start_agent escolhe a conta e o modelo sozinho: omita account_id".
- [ ] Step 4: PASS; commit `start_agent: account and model from the project setup`.

### Task 5: Project chat account and model

**Depends on:** TER-588 merged (rebase first). **Files:** `apps/server/src/chat/host.ts`, `apps/server/src/chat/service.ts` (host call site + `LimitFallback` success hook), `apps/server/src/chat/account-fallback.ts` (body of `fallbackCandidates`), repo `chat` (`setRunAccount(conversationId, accountId)` on the project row), tests `host.test.ts`, `account-fallback.test.ts`.

**Interfaces:** `HostAccount` gains `{ kind: 'project'; id: string; label: string }`; `resolveHost(ctx, user, { ..., project?: { id: string; accountId: string | null } })`; `HostChoice.ready` gains `model: string | null` (project default or null); `HostContext.repos` adds `projectSetup`.

- [ ] Step 1: tests — project with listed Claude accounts on host: sticky account kept when listed; not listed → first in order; project accounts only on another machine → today's account; account-wide chat unchanged; `model` from project; `fallbackCandidates` with projectId returns project order minus tried/current, dropping ≥90; without config unchanged.
- [ ] Step 2: implement; call sites pass `{ ...conversation, model: conversation.model ?? host.model }` into the run functions; after a fallback run ends without error in a configured project chat, `setRunAccount` stores the answering account on the project conversation.
- [ ] Step 3: PASS; commit `Chat: project chats run on the project's accounts and model`.

### Task 6: Tab swap preferences and the usage-limit card (server)

**Depends on:** TER-587 merged. **Files:** `apps/server/src/control/account-swap.ts` (`swapPreferences` body, the two args, off-flag branch → `notifyLimitInChat`), new `apps/server/src/chat/tab-limits.ts` (open/answer/close), `db/repositories/tab-questions.ts` (kind `usage_limit` accepted), `chat` routes (answer `POST /chat/tab-limits/:id/answer {account_id|null}` + m-api twin), chat payload list `tab_limits`, `chatBus` events `tab_limit`/`tab_limit_closed`, monitor ingest close on `rate_limited_at` cleared / tab removed. Tests alongside.

- [ ] Step 1: tests — `swapPreferences` returns project Claude accounts on the tab's machine + model; unconfigured → `{}`; flag off + configured project with another available account → one card per `(tab.id, rate_limited_at)`; flag off + no other account → no card; answer with account → `swapAccount(..., { accountId, auto: false })` and card answered; "Esperar" → dismissed; limit cleared → expired; card not in `tab_questions` payload list nor `tab_question*` events.
- [ ] Step 2: implement; PASS; commit `Swap: project priority and model; usage-limit card in the project chat`.

### Task 7: Web

**Files:** `apps/web/src/components/SetupForm.tsx` (new `ProjectAiCard` in `apps/web/src/components/setup/ProjectAiCard.tsx`, "Modelo" removed from Agente), `apps/web/src/lib/api.ts` (`api.setup.ai.get/save`, `api.chat.answerTabLimit`), `apps/web/src/lib/types.ts`, `apps/web/src/components/chat/ChatHost.tsx` (project account), new `apps/web/src/components/chat/TabLimitCard.tsx` wired where suggestions render.

- [ ] Step 1: ProjectAiCard — list `available` grouped by machine, checkbox, ↑/↓ on included, model select per provider present (`''`=Padrão do CLI, opus/sonnet/haiku for claude, "Outro id…" + input), free-id warning, own save button, errors shown inline.
- [ ] Step 2: ChatHost shows "Conta definida pelo projeto: X" + link to settings, hides picker in that case.
- [ ] Step 3: TabLimitCard — text from spec §7.2, buttons per candidate + "Esperar", disabled while posting, error inline.
- [ ] Step 4: `npm run typecheck -w @termhub/web && npm test -w @termhub/web` (Docker) PASS; commit `Web: project AI accounts card, project chat account, usage-limit card`.

### Task 8: Mobile

**Files:** `apps/mobile/app/project-ai/[projectId].tsx`, `apps/mobile/src/features/project-ai/*` (view + hook), `apps/mobile/src/services/api/contract/local.ts` (+ `tab_limits` default `[]`), chat host line/sheet link, a `TabLimitCard` in the chat feature, events handling for `tab_limit*`.

- [ ] Step 1: screen with toggles, ↑/↓ buttons, model choices, save; reached from host sheet "Contas e modelo do projeto" (project chats only).
- [ ] Step 2: host line shows project account; usage-limit card rendered and answered.
- [ ] Step 3: `npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile` PASS; commit `Mobile: project AI accounts screen and usage-limit card`.

### Task 9: Verify, integrate, ship

- [ ] Rebase on `origin/main` (after TER-587/588), resolve seams, full Docker verification (server typecheck + tests, web build, landing build, mobile typecheck, mobile-api tests).
- [ ] Whole-branch review (requesting-code-review), fix findings.
- [ ] PR with **Impact on other users**; merge on green CI; follow deploy to healthy (`docker ps`, curl vhosts); card to Feito.
