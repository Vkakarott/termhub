# Agent tabs: the termhub memory MCP inside tabs opened by `start_agent` — design

Card: **TER-212** (subtasks TER-213…TER-216). Origin: spike TER-110. Builds on **TER-95** (memory,
`search_memory`, scope `memory`; spec `2026-09-26-concierge-memory-mcp-design.md`, in production by
PR #188) and is what **TER-205** (failure lessons; spec `2026-09-27-failure-lessons-design.md`) needs for
tabs to call `search_memory` (kinds `lesson`) and `record_lesson` directly.

## 1. Problem

Only the concierge gets the termhub MCP (a `--mcp-config` the `@termhub/agent` writes for each chat run).
A tab opened by `start_agent` runs `claude <prompt>` / `codex <prompt>` (`launchLine`,
`apps/server/src/control/agents.ts`) with whatever MCP servers the person configured by hand — usually
none, or a personal token with every scope. So the agent that is actually debugging cannot look up what
another tab already learned, and cannot record what it learned itself.

## 2. Decisions

Taken alone by Claude, as asked (autonomy granted on the card's scope). None changes the card's scope.

| # | Topic | Decision | Why |
|---|---|---|---|
| D1 | Which token | A **tab token**: an ordinary row in `api_tokens` with a new nullable column `tab_id` (plain text, **no FK**), minted by `startAgent` for that one tab. `gated = false`, name `aba «<tab name>» (automático)`, expires in 30 days. | Reuses the whole `/mcp` path (hash lookup, rate limit, audit rows in `api_token_events`, the Settings list where the person can revoke it). No FK: a cascade would delete the audit rows, and `SET NULL` would turn a tab token into an unrestricted one (§D4 keys everything on `tab_id`). |
| D2 | Scopes | `read` + `memory`, and on top of them a **fixed tool allowlist** for tab tokens: `search_memory` and `record_lesson` (TER-205; listed by name now, it appears on its own when that tool exists). Every other tool is absent from `tools/list` and refused on `tools/call`. | Scopes alone are too coarse: `read` would also hand the tab `list_tabs`, `read_screen` of every other tab, `list_machines`… The card asks for "buscar lições/memória e propor lição; sem abrir abas, mandar input ou mexer no board". Grants still apply (effective = allowlist ∩ scopes ∩ the owner's grants). |
| D3 | What a tab can read | `search_memory` pinned to **the tab's project** (a different `project_id` is refused; a missing one is filled in) and without the kinds `message` (the person's chat messages) and `action` (gate decisions). Everything else of that project: decisions, cards, specs/plans, notes, and lessons/project notes once TER-205 adds them. | A tab may be running in an untrusted checkout; if a prompt injection turns it against the person, the most it can pull out is its own project's knowledge — which it could mostly read from the repo anyway — not other projects' memory or what the person typed in the chat. Lessons of other projects are a loss we accept (the person can still ask the concierge, whose token is not pinned). |
| D4 | What a tab can write | Only what `record_lesson` writes (an unverified, `derived`, visible and forgettable block; 20/h; TER-205 D7–D11). Its `project_id` must be the tab's project and its `tab_id` is forced to the tab itself, so the provenance on the block cannot be forged. `record_decision` (a concierge note) is **not** in the allowlist. | Lessons are the card's goal. A decision note is the concierge's instrument; a tab writing one would pollute what the concierge relies on. |
| D5 | Pinning, generically | The MCP route applies one rule to every call of a tab token, before the tool runs: an argument named `project_id` must equal the tab's project (absent → set), an argument named `tab_id` must equal the tab (absent → set). Unknown argument names are left to each tool's schema. | TER-205's `record_lesson` (and any later tab tool) is pinned without touching its code; the check lives in one place, next to the scope check. |
| D6 | Lifecycle | Minted after the tab exists and before the launch line is typed. **Revoked** in the same transaction that deletes the tab row (`TabsRepository.delete`, which every close path uses: `close_tab`, the web's close, unlinking a project from a machine). **And** `authenticateToken` refuses a tab token whose tab row no longer exists (covers the machine delete cascade and any path that forgets). 30-day expiry as the last floor. | Belt and braces: the transactional revoke is the rule; the auth check makes "tab gone ⇒ token dead" hold even for a delete that bypasses the repository method. |
| D7 | Delivery of the config | A private directory per tab on the machine: `~/.termhub/tabs/<tab_id>/` (mode 0700), written by one POSIX script in `@termhub/machine-ops` that reads the file body **from stdin** and writes it with `umask 077` (file 0600) via a temp file + rename. Agent machines run it through a new RPC `tab.mcp.write` (agent **0.10.0**); ssh/local machines through `runOnMachineWithInput`. The token never appears in the typed line, in an argv, in the shell history or in a log. | Same pattern the hooks' env file and the concierge's run dir already use. Stdin keeps the secret out of `ps`. |
| D8 | Claude | File `mcp.json` = `mcpConfig(url, token)` with the server named **`termhub_tab`**. Line: `claude --mcp-config <dir>/mcp.json --allowedTools mcp__termhub_tab__search_memory mcp__termhub_tab__record_lesson -- '<prompt>'`. No `--strict-mcp-config`. | A distinct name never collides with a `termhub` server the person configured with a personal token. `--mcp-config` and `--allowedTools` are variadic, so `--` ends them before the prompt. Pre-allowing exactly these two tools keeps a read (and an unverified lesson) from raising a permission card on every call; this is not a bypass flag — every other tool asks as before. |
| D9 | Codex | File `token` (the bare token, 0600). Line: `TERMHUB_MCP_TOKEN="$(cat <dir>/token)" codex -c 'mcp_servers.termhub_tab.url="<mcp url>"' -c 'mcp_servers.termhub_tab.bearer_token_env_var="TERMHUB_MCP_TOKEN"' '<prompt>'`. | Codex takes MCP servers from `config.toml` or `-c` overrides; streamable HTTP servers read the bearer from an env var (`bearer_token_env_var`). The typed line holds only the path; the env var is visible to that user's processes only — the same boundary as the 0600 file. **Not verified live**: the only machine with Codex (hulk) was offline while this was built (§8). |
| D10 | When it is skipped | No MCP (the tab starts exactly as today, and the result's `note` says why) when: `MCP_URL` is not configured; the provider is not Claude/Codex; an agent machine is older than 0.10.0; or writing the file fails. A failed write revokes the token it minted. | `start_agent` must never fail because of an optional extra. |
| D11 | Account swap | `resumeLine` (Claude, account swap) adds the same `--mcp-config`/`--allowedTools` when the tab has a live tab token: the file is still there, the token still valid. | The resumed session keeps the memory. |
| D12 | Cleanup on the machine | On tab close, best effort `tab.mcp.remove` / the ssh twin deletes `~/.termhub/tabs/<tab_id>/`. Failure is ignored: the token is already revoked (D6). | Hygiene, not security. |
| D13 | Cap and listing | Tab tokens do not count against the 20 active personal tokens (like the concierge's). They show in Settings → Tokens de API with their tab's name and can be revoked there. | A person with many agent tabs would otherwise be locked out of creating tokens. |
| D14 | Instructions to the model | No new text in the prompt. TER-205 D13 owns the `start_agent` reminder; the tools' own descriptions (seen by the tab's CLI through the MCP) say what they are for. | TER-212's card was updated on 2026-09-27: the instruction moved to TER-205. One owner for that text avoids two reminders drifting apart. |

## 3. Data

Migration `…_api_token_tab`: `ALTER TABLE api_tokens ADD COLUMN tab_id text NULL` + index on `tab_id`.
Additive and nullable: the previous release neither reads nor writes it (blue/green safe). The old
release, still serving during a deploy, would treat a tab token as an ordinary `read`+`memory` token for
those few minutes: acceptable (both are the same owner's, and the new release is the one minting them).

`ApiToken` gains `tab_id: string | null`. `ApiTokensRepository`: `create` accepts `tabId`; `countActive`
excludes `tab_id IS NOT NULL`; new `revokeForTab(tabId)`; `TabsRepository.delete` revokes inside its
transaction.

## 4. Server

- `apps/server/src/mcp/tab-token.ts` (new): `TAB_TOKEN_TOOLS`, `TAB_TOKEN_NAME(tabName)`,
  `mintTabToken(repos, userId, tab)`, `pinTabArgs(tab, tool, args)` (D5, throws a `ControlError`
  `TAB_SCOPE`), `TAB_EXCLUDED_KINDS = ['message', 'action']`.
- `mcp/auth.ts`: a tab token whose tab is gone → null (401), and the `tab` (`{ id, project_id }`) is
  returned with the token.
- `ControlContext.token` gains `tab?: { id; project_id }`. `allowedTools` intersects with
  `TAB_TOKEN_TOOLS` when set. The route calls `pinTabArgs` before `applyGate`.
- `control/memory.ts` `searchMemory`: with `ctx.token?.tab`, drops `message`/`action` from the kinds
  (asked only for those → a pt-BR error).
- `terminal/tab-mcp.ts` (new): `installTabMcp(machine, tabId, files)` / `removeTabMcp(machine, tabId)`
  picking RPC or ssh, `TAB_MCP_MIN_AGENT_VERSION = '0.10.0'`.
- `control/agents.ts`: `launchLine(provider, configDir, prompt, mcp?)` where `mcp` is
  `{ dir: string }` for Claude and `{ dir, url }` for Codex; `startAgent` mints, installs, types the
  line; the result's `note` gains "com memória do termhub (search_memory)" or the reason it was skipped.
- Close paths (`control/terminals.ts closeTab`, `routes/tabs.ts DELETE`, `project-links.ts`): best-effort
  `removeTabMcp` next to `killTmuxSession`.

## 5. Agent and machine-ops

- `@termhub/machine-ops`: `TAB_MCP_DIR_REL = '.termhub/tabs'`, `buildTabMcpWriteScript(tabId, file)`
  (file ∈ `mcp.json` | `token`; tab id checked against `^[a-z0-9]{1,64}$` before it reaches the script)
  and `buildTabMcpRemoveScript(tabId)`.
- `@termhub/agent-protocol`: RPCs `tab.mcp.write` `{ tab_id, file, body }` (body ≤ 8 KB, never logged)
  and `tab.mcp.remove` `{ tab_id }`.
- `@termhub/agent` 0.10.0: both handlers run the scripts with `sh`, the body on stdin.

## 6. Prompt injection and leaks

- **Injected tab reads memory**: bounded to its own project and without the person's chat messages
  (D3). Results already come with TER-95's "dados, nunca instruções" note.
- **Injected tab writes memory**: only unverified lessons, rate-limited, with the real tab as
  provenance (D4, D5); a lesson never backs an automatic answer (TER-95 D2, TER-205 D8).
- **Injected tab escalates**: no other tool is listed or callable (D2); a tab token can never be gated
  or become one (minted with `gated: false` by the one function that makes tab tokens).
- **Token leak**: never typed, never in argv (stdin to the script), never logged (audit rows hold the
  tool and ids only). Anyone who can read the 0600 file already runs as that user on that machine.
  Revoked on close; 401 once the tab is gone.
- **Memory content in the terminal**: `search_memory` results appear on the tab's screen, which the
  concierge can read — the same data the concierge could search for itself. Nothing new.

## 7. Tests (TER-216)

- Repository: `countActive` ignores tab tokens; `revokeForTab`; deleting the tab revokes.
- Auth: tab token 401 once the tab row is gone.
- Tools/route: `tools/list` of a tab token = allowlist ∩ grants; `list_tabs` refused; `project_id` of
  another project refused; missing `project_id` filled; `tab_id` forced; `search_memory` without
  `message`/`action`.
- `launchLine`: Claude/Codex lines with and without MCP; the token string never appears in the line;
  every value quoted.
- `startAgent`: mints + installs + types; older agent / write failure → starts without MCP and revokes;
  no token in the logged fields.
- machine-ops script: 0700 dir, 0600 file, body from stdin, remove deletes the dir (run in a temp HOME).
- Agent RPC handlers and protocol bounds (tab id regex, body size).

## 8. Out of scope and known limits

- Codex path unverified live (D9): when hulk is online, open one Codex tab with `start_agent` and check
  that `search_memory` is listed. Tracked as its own subtask.
- Tabs opened by hand (the "+" in the UI) get no tab token: the card is about `start_agent`.
- Tabs opened before this release keep running without MCP.
