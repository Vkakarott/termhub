# Project AI accounts, priority and default model (TER-589)

Date: 2026-09-30. Card: TER-589. Neighbours: TER-587 (tab auto swap), TER-588 (chat usage-limit error and chat swap).

## 1. Goal

A project's setup says which AI accounts (per machine) its agents use, in which order, and the model
conversations start with. `start_agent`, the tab account swap and the chat read it; the model is passed
explicitly to the CLI. A project with no such configuration behaves exactly as today.

Why: on 2026-09-30 the default Claude account hit its 5 h limit, nothing swapped, the chat answered a
generic error, eight tabs were restarted by hand with `--model`, and editing `settings.json` to change the
default model broke the concierge container, whose older CLI did not know the model id.

## 2. Owner decisions (card questions, 2026-09-30)

- **Model validation:** aliases the CLI resolves itself (`opus`, `sonnet`, `haiku`) plus a free id. A free
  id is accepted with a warning that an older CLI may not recognise it. No probe run on save.
- **Priority:** when the current account hits the limit, swap to the **next account in the configured
  order**, skipping accounts at or above 90 % usage — not the most free one.
- **Chat:** in the chat of a configured project the project's list rules the account and the model; the
  manual host choice keeps ruling the account-wide chat and unconfigured projects.
- **Auto swap:** a project list never overrides a machine whose `claude_auto_swap` was turned off on
  purpose. In that case the project's tabs do not swap by themselves, and the project's chat shows a card
  saying the account's quota ran out, offering the manual swap.

## 3. Data

New block `ai` in `project_setups.data` (JSON validated with zod in `apps/server/src/setup/schema.ts`; no
migration):

```ts
ai: {
  accounts: string[];                     // ai_accounts ids, priority order, unique, max 20
  models: { claude: string | null; chatgpt: string | null };
}
```

- Default: `{ accounts: [], models: { claude: null, chatgpt: null } }`. A project is **configured** for a
  provider on a machine when it lists at least one account of that provider on that machine; its model is
  configured when `models[provider]` is set. Both are independent.
- Model format: `^[A-Za-z0-9._:\[\]-]{1,100}$` (covers `opus`, `sonnet[1m]`, `claude-opus-5-5`,
  `gpt-5-codex`). Stored as typed.
- Save-time checks (route, through `scoped()`): every id is an AI account in the caller's scope, of
  provider `claude` or `chatgpt` (the providers `start_agent` can launch), on a machine linked to the
  project. Anything else is a 400 naming the account.
- Read-time tolerance: ids whose account was deleted, changed provider or sits on a machine no longer
  linked to the project are skipped silently — the setup is never rewritten by a read.
- `agent.model` (the free-text "Modelo" in the "Agente" card) was never read by the server. It leaves the
  screen and stays in the schema, and is **not** adopted: adopting it would silently change behaviour for
  whoever typed something there.
- `SETUP_VERSION` stays 2: `normalizeSetup` already fills missing blocks with defaults.

### Endpoints

- `GET /projects/:id/setup/ai` → `{ ai, available: AccountOption[] }`, where `AccountOption` is
  `{ id, label, provider, machine_id, machine_name, default }` for every Claude/Codex account on the
  project's linked machines (`default` = `config_dir === null`).
- `PUT /projects/:id/setup/ai` with `{ ai }` → same shape. Resource `projects`, actions read/update, as the
  existing setup routes.
- Mobile: `GET/PUT /api/m/v1/projects/:id/ai`, same bodies, contract in `packages/mobile-api`.
- The full `PUT /projects/:id/setup` keeps the stored `ai` block and ignores one in the body, so a stale web
  form never erases an edit made on the phone (and vice versa).

## 4. Server module `apps/server/src/ai/project-accounts.ts`

Pure where it can be; the one DB-touching helper takes `repos`.

- `projectAi(data): ProjectAi` — the parsed block.
- `accountsOn(ai, accounts: AiAccount[], machineId, provider): AiAccount[]` — the project's accounts of
  that provider on that machine, in priority order, dropping unknown ids.
- `modelFor(ai, provider): string | null`.
- `isAlias(model): boolean` — `opus | sonnet | haiku` (optionally with a `[...]` suffix).
- `loadProjectAi(repos, projectId)` — reads the setup and the owner's accounts once.

`rankCandidates(accounts, usage, { explicit, priority? })` in `control/account-swap.ts` gains the optional
`priority`: when given, the candidates are those ids in that order, still dropping accounts at or above
`SWAP_MAX_UTILIZATION` unless explicit; unknown usage counts as available. Without `priority` the ranking
is TER-587's, unchanged.

## 5. `start_agent`

- `account_id` becomes optional. Without it, when the project lists accounts on the chosen machine, the
  first one in order that is available (below 90 %, or usage unknown) is used; if none is available, the
  first in order is used and the result says it is at its limit. Without it and without configuration,
  the error is today's (`account_id` required, listing the machine's accounts).
- `machine_id` omitted on a project with several machines: when the project lists accounts, the machine of
  the first available account is used; otherwise today's error.
- New optional `model`. Effective model: `model` argument → `modelFor(ai, provider)` → none (no flag).
- `launchLine(provider, configDir, prompt, mcp?, model?)` and `resumeLine(configDir, sessionId, prompt,
  mcpTabId?, model?)` add `--model <m>` (claude) / `-m <m>` (codex), always through `shellQuote`.
- The result carries `account { id, label }`, `model` and a `warning` when the model is not an alias
  ("o CLI desta máquina pode não reconhecer este id; se a aba mostrar erro de modelo, use um apelido").
- The concierge prompt says that in a project with configured accounts it may omit `account_id`.

## 6. Tab account swap (with TER-587)

TER-587 ships `swapPreferences(repos, tab): Promise<{ priority?, model? }>` returning `{}` and marks the two
call sites in `swapAccount`. TER-589 fills it: the project's Claude accounts on the tab's machine as
`priority`, and `modelFor(ai, 'claude')` as `model`, passed to `rankCandidates` and `resumeLine`.

Auto swap stays gated on `machines.claude_auto_swap` alone (TER-587 turns it on by default). When the flag
is off and a tab of a project with at least one other available project account on that machine hits the
limit, the project's chat gets a **usage-limit card** (§7.2).

## 7. Chat

### 7.1 Account and model of a project chat

In a project chat whose project lists Claude accounts on the chat's host machine:

- The run starts on the **sticky** account: the project conversation's own `ai_account_id` when it is still
  one of those accounts; otherwise the first one in order. The account-wide conversation's host (machine
  and manual account) is not touched.
- If that account hits the limit mid-run, TER-588's in-run fallback moves the session
  (`linkChatSession`) to the next candidate and re-runs the turn; TER-589 fills `fallbackCandidates(...,
  projectId)` with the project order on that machine. After a fallback answers successfully in a
  configured project chat, the answering account is stored on the project conversation's
  `ai_account_id`, so the next message starts there.
- The run's model is `conversation.model ?? modelFor(ai, 'claude')`.
- `resolveHost` reports this as a new account kind `project` (`{ kind: 'project', id, label }`), shown by
  the web `ChatHost` and the mobile host line as "Conta definida pelo projeto: X". The account picker is
  hidden for that project chat, with a link to the project setup.

Everything else (account-wide chat, unconfigured projects, projects whose accounts are on other machines)
keeps today's resolution.

### 7.2 Usage-limit card

When a project tab hits the limit and does not swap by itself because the machine's auto swap is off
(§6), a card opens in the project's active chat conversation:

- Text: "A conta <label> da aba <tab> atingiu o limite de uso (cota de tokens esgotada)
  até <reset>. A troca automática está desligada na máquina <machine>." Buttons: one "Trocar para <label>"
  per available project account on that machine, in order, and "Esperar".
- Choosing an account calls the existing manual swap (`swapAccount` with that account, explicit) and
  closes the card as answered; "Esperar" dismisses it. The card closes as expired when the tab's
  `rate_limited_at` clears or the tab is removed. At most one open card per tab.
- Hook: TER-587's `autoSwapOnLimit` bails out when the machine flag is off; that branch calls
  `notifyLimitInChat(repos, tab)`. One card per incident, deduplicated on `(tab.id, tab.rate_limited_at)`
  (a second StopFailure of the same incident keeps the same `rate_limited_at`). Failures of the automatic
  swap with the flag on (TER-587's "Troca automática falhou") stay on the tab and open no card.
- Stored in `tab_questions` with a new kind `usage_limit` (payload `{ account, resets_at, machine,
  candidates: [{ id, label }] }`). Like suggestions, it travels on **its own events** (`tab_limit`,
  `tab_limit_closed`) and its own list (`tab_limits`) in the chat payload, because the mobile contract's
  `tabQuestionSchema` is a strict discriminated union: an installed app that predates it must keep parsing
  `tab_question*` events. Old apps ignore the new keys (plain `z.object` strips them).
- Rendered in the web chat and the mobile chat.

## 8. Screens

- **Web** — a new card "Contas de IA e modelo" in `SetupForm`, saved through its own endpoint:
  - The accounts of the linked machines, each with its machine name; a checkbox includes it; up/down
    buttons order the included ones. Empty list note: "Sem contas escolhidas, cada início de agente pede a
    conta, como hoje."
  - One model select per provider that has an account on a linked machine: "Padrão do CLI", `opus`,
    `sonnet`, `haiku` (Claude), and "Outro id…" with a text field and the warning for free ids.
  - The "Modelo" input leaves the "Agente" card.
- **Mobile** — a screen `project-ai/[projectId]` reached from the project chat's host line/sheet ("Contas e
  modelo do projeto"), with the same editing: toggles, up/down buttons (no new native module), model
  choices. Copy in pt-BR.

## 9. Impact on other users

Nothing changes until someone configures a project: the block is opt-in per project, and with it empty
`start_agent`, the swap and the chat behave as today. The only visible change for everybody is that the
inert "Modelo" field leaves the "Agente" card. The usage-limit card only opens for projects with accounts
configured on a machine whose auto swap was turned off. Installed mobile apps keep working: the card uses
new events and a new list they ignore.

## 10. Testing

- Schema: defaults, model format, duplicates, max 20.
- `project-accounts`: `accountsOn`, `modelFor`, `isAlias`, unknown ids skipped.
- `rankCandidates` with `priority` (order kept, ≥90 % skipped, explicit keeps it, unknown usage available).
- `launchLine` / `resumeLine` with and without model, quoting.
- `start_agent`: optional account, machine from priority, model precedence, today's error unchanged.
- Setup AI route: scope (another owner's account → 400), unlinked machine → 400, full PUT keeps `ai`.
- Chat: `resolveHost` project kind, sticky account, model at the run call site.
- Usage-limit card: opens once, swap answer, expiry on clear; mobile contract parses old and new payloads.
- Typecheck and builds through Docker (CLAUDE.md), mobile typecheck.

## 11. Out of scope

Probing the CLI for supported models; Gemini/Antigravity launch; per-user default models; changing the
account-wide chat's host rules; TER-587's detection fixes and TER-588's error codes.
