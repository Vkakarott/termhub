# Agents on the machine's default login, and open tabs linked to cards (TER-499)

## 1. Problem

The Progresso panel (TER-183) shows the agents of a card from the tab linked to it (`tasks.tab_id`).
Only two things make that link: `start_agent` with `task_id`, and `POST /tasks/:id/terminal`, which opens
a **new** tab. In daily use the concierge does neither: it opens a tab with `open_tab` and types
`unset CLAUDE_CONFIG_DIR; claude` into it, because the AI account it can pick on that machine runs under
another config dir and it has no way to ask for the machine's own login. No tab ends up linked to a card,
so Progresso shows no agent.

Three gaps, checked in the code:

- **The default login cannot be picked.** An AI account with `config_dir = null` already means "the
  machine's default login" everywhere (`configDirPrefix`, the chat run in `apps/agent/src/claude/run.ts`,
  the hooks), and `launchLine` sets no variable for it. But `list_ai_accounts` hides the config dir on
  purpose, so two Claude accounts of one machine cannot be told apart, and the account form only hints at
  it with an optional field whose placeholder is a path.
- **An inherited variable wins.** For such an account `launchLine` types a bare `claude '<prompt>'`: a
  `CLAUDE_CONFIG_DIR` exported in the tab's shell silently picks another login. The chat run already
  deletes the variable for `null`; the tab launch does not.
- **A tab that is already open cannot be linked to a card**, from the chat or from the app.

## 2. Decisions

| # | Decision |
|---|----------|
| D1 | `config_dir = null` stays the one meaning of "the machine's default login" — whatever dir the CLI uses when its config variable is unset. No path is written anywhere for it, no migration, and an account stored with an explicit dir (even one that spells the CLI's default) is left exactly as it is. |
| D2 | For an account without a config dir, `launchLine` and `resumeLine` clear the provider's variable in the tab's shell before the CLI: `command -v unset >/dev/null 2>&1 && unset CLAUDE_CONFIG_DIR; claude …` (`CODEX_HOME` for Codex). `unset` and not `env -u`: `env` would run the binary from `PATH` and skip the person's `claude` alias or shell function, breaking people who never had the variable set. The `command -v unset` guard keeps fish quiet (it has no `unset`): there the line behaves as today. Clearing the variable of a tab's own shell is what the launch is for; the tab is opened by `start_agent` for this agent. |
| D3 | `list_ai_accounts` and the `ai_account` matches of `find` gain `default: boolean` (`config_dir === null`). Still never the path. The `start_agent` and `list_ai_accounts` descriptions say what it means. |
| D4 | The account form asks explicitly: "Conta padrão da máquina" (stores `null`) or "Outro diretório de config" (the dir field, required). The card of a default account says "login padrão". |
| D5 | `linkTabTask(ctx, { tab_id, task_id })` in `control/agents.ts`: needs `tasks:update`; tab and card are loaded through the scope; the tab must be a terminal tab of the card's project; then the same two steps `start_agent` does (`tasks.setTab`, `tasks.startWork`), shared in one helper. Linking again to the same tab is a no-op that still answers the card. A card linked to another tab is re-pointed and the answer names the previous tab. Several cards may point at one tab, as today. |
| D6 | MCP tool `link_tab_task { tab_id, task_id }`, token scope `tasks`, grant `tasks:update`. In the chat gate it is a `write`: always a confirmation card, not covered by the board grant or any standing grant (those sets are closed on purpose; widening them is its own decision). Its card reads "ligar a aba à tarefa TER-12 …". It types nothing, so the gate's permission-dialog checks do not apply to it; a closed tab still fails the approval (`TAB_GONE`). Not offered to tab tokens. |
| D7 | REST `POST /tasks/:id/link-tab { tab_id }` (resource `tasks`, action `update`) runs the same control operation. The card editor gets "Ligar a uma aba aberta" (a select of the project's open terminal tabs) when the card has no tab, and "desligar" (the existing `DELETE /tasks/:id/terminal`) when it has one. |
| D8 | `ORCHESTRATOR_PROMPT` gains one rule: to put an agent on a card, `start_agent` with `task_id`, picking the account with `list_ai_accounts` (`default: true` is the machine's own login); never start an agent by typing the CLI into a tab opened with `open_tab`; a tab that was opened by hand for a card is linked with `link_tab_task`. |
| D9 | No account detection button. Registering the default login is one choice in the form; detection would need a new agent RPC and an agent release for a one-time convenience. |

## 3. Out of scope

- The mobile app gets no new screen: a `link_tab_task` confirmation reaches it as the sentence the server
  builds, like every other gated tool.
- `@termhub/agent` does not change (no release). Its chat run already clears the variable for `null`
  (`apps/agent/src/claude/run.test.ts`).
- Unlinking from the chat: the app's "desligar" is enough.

## 4. Impact on other users

- **Default for everyone, one behavior change (D2).** A person who exports `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` in their shell rc *and* registered the account with an empty config dir gets, from
  `start_agent` and from an account swap, an agent on the CLI's default login instead of the exported
  one. That is what the account already meant for its usage bars and for the chat. The fix on their side
  is to put the dir in the account. People who do not export the variable see a longer typed line and the
  same agent. fish users see no change at all.
- **Opt-in (D4, D5–D7).** Nothing assumes where a login lives or what a machine is called: the default
  login is a per-account choice on any machine, and linking a tab is an action a person takes. Both do
  nothing for someone who does not use them.
- **Additive (D3).** One boolean more in two tool answers.
- **Default for everyone (D8).** Every concierge now prefers `start_agent` with `task_id`, so a card moves
  to the project's agent column when an agent starts on it — what `start_agent` always did.

## 5. Testing

- `control/agents.test.ts`: the cleared-variable line for both providers, with and without the tab MCP,
  and in `resumeLine`; an explicit dir unchanged; `linkTabTask` (links and starts work, same tab twice,
  previous tab named, other project, non-terminal tab, missing grant, another owner's tab or card).
- `control/inventory.test.ts`, `mcp/tools.test.ts` / `route.test.ts`: `default`, the new tool listed.
- `chat/gate.test.ts`, the chat-actions view test, `gate-runtime` test: class, sentence, no permission check.
- `routes/tickets.test.ts`: the route. `chat/concierge-prompt.test.ts`: the rule, and the prompt's size.
- Web: `AiAccountsView.test.tsx` (the choice stores `null` or the dir), `TaskEditor.test.tsx` and
  `TasksBoard.test.tsx` (link and unlink).
- After deploy, by hand: `start_agent` with a default account and `task_id`; the tab shows on the card in
  Progresso.
