# Concierge tools: an allowlist instead of a denylist — design

Card: **TER-127** (bug). Found during TER-59 and parked in
`docs/superpowers/specs/2026-09-26-concierge-always-free-design.md` §9. Implementation plan:
`docs/superpowers/plans/2026-09-26-concierge-tool-allowlist.md`.

The user asked for the decisions to be made without a review round, so each one below carries its reason.

## 1. Problem

The concierge must reach a machine only through the termhub MCP, where the permission gate lives
(spec 2026-09-21 §4.1). `@termhub/claude-cli` enforces this with a **denylist**:
`--disallowed-tools Bash,Read,Write,Edit,WebFetch,WebSearch`. Every built-in tool that is not on the list
is still there, and the list was written for an older CLI.

## 2. What the CLI does today (probed 2026-09-26, Claude Code 2.1.283, haiku)

All probes used the concierge's argv (`-p`, `--strict-mcp-config`, `--allowed-tools mcp__termhub__*`,
the current `--disallowed-tools`), run from a scratch directory.

| Probe | Result |
|---|---|
| Tools in the `system/init` frame with today's argv | 25 built-ins: `CronCreate, CronDelete, CronList, DesignSync, EnterWorktree, ExitWorktree, Glob, Grep, ListAgents, Monitor, NotebookEdit, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, Skill, Task, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, ToolSearch, Workflow`. |
| `Grep` for a file inside the working directory | **Allowed without asking**: the concierge printed `segredo=abc123` from `secret.env`. |
| `Grep` on `/etc/passwd` (outside the working directory) | Asks for permission, which `-p` denies. |
| A custom subagent (`--agents`, `tools: [Glob, Grep]`, as a `~/.claude/agents` file would define) with today's argv | Read the file (leaked). |
| Same, with `Glob,Grep` added to `--disallowed-tools` | Blocked. |
| Same, with `--tools Agent` | Blocked: "Permission to use Grep has been denied". |
| `--tools Agent`: tools in `init` | `Task` (the subagent tool) plus every `mcp__termhub__*` tool. |
| `--tools Agent` with 61 MCP tools | All 61 loaded directly (no `ToolSearch` deferral); the model called one and got its result. |
| `--tools Agent`: a `general-purpose` subagent lists its tools | Only `Agent` and the MCP tools. |
| `--tools ''` | No tools at all (would kill the subagents, so not an option). |
| `--disallowed-tools` naming tools the CLI does not have (`PowerShell`, `NoSuchTool`) | Accepted, exit 0. |
| An unknown flag (what an old CLI would say about `--tools`) | `error: unknown option '--bogus-flag'` on stderr (lowercase `error:`). |
| Container CLI (`termhub-concierge` image, 2.1.278) | Has `--tools`. |

**Where it hurts.** The agent runs the CLI with its own working directory, which is the person's home
(`WorkingDirectory` = `os.homedir()` in the launchd plist; a systemd user unit defaults to home too).
Read-only tools need no permission inside the working directory, so the concierge and its subagents can
`Grep`/`Glob` all of `~` — `.ssh`, `.env` files, cloud credentials — without the gate and without the
person seeing a card. `NotebookEdit`, `Monitor`, `EnterWorktree`, `RemoteTrigger` and friends ask for
permission, which `-p` denies, **unless the account's own settings allow them**: the CLI loads the
account's `settings.json` (`permissions.allow`), and only `--disallowed-tools` / `--tools` override that.

## 3. Decisions

| Topic | Decision | Why |
|---|---|---|
| Main fix | Pass **`--tools Agent`**: the built-in set is exactly the subagent tool. MCP tools are not built-ins and stay governed by `--allowed-tools mcp__termhub__*`. | A denylist rots with every CLI release (2.1.283 has 25 built-ins, several of which did not exist when the list was written). An allowlist fails closed: a tool added next month is simply absent. Probed: MCP and background subagents keep working, subagents inherit the set. |
| Second layer | **Keep `--disallowed-tools`** and extend it to every built-in that reads or writes the machine's files, runs code on it, or reaches the network: `Bash,PowerShell,Monitor,Read,Write,Edit,NotebookEdit,Glob,Grep,EnterWorktree,WebFetch,WebSearch,RemoteTrigger`. | Deny rules win over the account's allow rules in any CLI, and naming absent tools is harmless (probed). If a future CLI changes what `--tools` means for custom subagents, the dangerous ones are still denied by name. Cheap, and both layers were probed to block the custom-subagent case on their own. |
| Order in argv | `--tools Agent` right after `--disallowed-tools`, in both one-shot and streamed runs. | One argv for every run; the streamed flags keep their position after it. |
| Tools kept out on purpose | `ToolSearch`, `TaskStop`, `SendMessage`, `Skill`, `Workflow`, the cron/task-list tools. | The concierge's work is MCP calls and background subagents. `ToolSearch` is not needed (probe: MCP tools load directly without it). Cancelling a subagent is TER-64/65's job; if that design wants the model to call `TaskStop`, it adds it to the allowlist deliberately. |
| Old CLIs | No version check in the agent. `classifyFailure` also maps `error: unknown option` to **`cli_rejected`**. | The web and the app already say, for `CLI_REJECTED`: "O Claude Code dessa máquina recusou os parâmetros do chat. Atualize o claude nela e tente de novo." — exactly the advice. A version probe per run costs a spawn and duplicates what the CLI already tells us. |
| Agent release | `@termhub/agent` **0.7.1** (patch). No protocol change, no new capability. | The argv is built inside the agent (`apps/agent/src/claude/run.ts` → `buildClaudeArgs`), so only a new agent carries the fix. CI publishes on merge. |
| Old agents (≤ 0.7.0) | **Not blocked** by the server. | Blocking would take the chat offline on every machine without `agent_auto_update` until someone clicks "Atualizar" in Máquinas; machines with auto-update get 0.7.1 within the hour. The gap is recorded as a risk (§6); a server-side minimum can be its own card if wanted. |
| `--restricted` (considered, rejected) | Not used. | It ignores the account's settings files and only confines file tools to the working directory, which is `~` here — so on its own it does not close the hole, and it changes behaviour beyond this card. `--tools` removes the tools outright. |
| Hook | `CONCIERGE_SETTINGS` (`PreToolUse` on `Agent|Task`) unchanged. | `--tools Agent` keeps the tool the hook watches; the final smoke test checks the hook still refuses a foreground subagent. |
| Orchestrator prompt | Unchanged. | It never mentions file tools; the model sees its own tool list. |
| Container runner (`apps/concierge`) | Gets the same argv through the shared package; its literal test is updated. | Unused since the agent runner, and its image is not rebuilt by the blue/green deploy (and the live `termhub-concierge-1` is never touched from here). Its 2.1.278 CLI has `--tools`, so a future rebuild just works. |

## 4. Components

### 4.1 `@termhub/claude-cli` (`packages/claude-cli/src/index.ts`)

- `CONCIERGE_TOOLS = 'Agent'`, with a comment saying why it is an allowlist and what is left out.
- `DISALLOWED_TOOLS` extended as in §3, comment updated (second layer, account allow rules).
- `buildClaudeArgs` emits `'--tools', CONCIERGE_TOOLS` after the `--disallowed-tools` pair.
- `classifyFailure`: `/^error: unknown option/m` → `cli_rejected` (the existing `/^Error: --/m` stays).

### 4.2 `@termhub/agent` 0.7.1

- `apps/agent/package.json`, `apps/agent/src/version.ts`, `package-lock.json`.
- `run.test.ts`: besides "argv equals `buildClaudeArgs(...)`", assert the spawned argv carries the
  `--tools Agent` pair and denies `Glob` and `Grep` — so an agent built against a stale `claude-cli`
  cannot pass.

### 4.3 `@termhub/concierge`

- `run.test.ts`: the literal argv gains the new deny list and `--tools Agent`.

### 4.4 Docs

- `2026-09-26-concierge-always-free-design.md` §9: the Glob/Grep bullet points to this spec as resolved.

## 5. Testing

- `packages/claude-cli/src/argv.test.ts`: exact argv (literal strings, not the constants), streamed argv
  keeps `--tools` before `--input-format`, no argv ever lacks `--tools`.
- `packages/claude-cli/src/classify.test.ts`: `error: unknown option '--tools'` → `cli_rejected`;
  `Error: unknown model` style lines stay `run_failed`.
- `apps/agent/src/claude/run.test.ts`: the pair on the spawned argv (fake CLI recorder, existing).
- `apps/concierge/src/run.test.ts`: literal argv.
- Typecheck/build through Docker as in `CLAUDE.md`.
- **Smoke with the real CLI (2.1.283)**, argv produced by the built `buildClaudeArgs`, a stdio fake MCP
  server named `termhub`, run from a scratch dir with a `secret.env`:
  1. `init` lists `Task` plus MCP tools only;
  2. asking for `Grep` on `secret.env` does not print its content;
  3. a custom subagent declaring `Glob, Grep` cannot read it;
  4. the MCP tool is called and answers;
  5. streamed run: a foreground `Agent` is refused by the hook, a background one runs and its notification
     turn arrives.

## 6. Risks

- **Agents not updated keep the hole** until 0.7.1 lands (auto-update within an hour; otherwise the
  "Atualizar" button). The server does not block them (§3).
- **Old CLIs without `--tools`** stop answering in the chat with the `CLI_REJECTED` message until the
  person updates `claude`. Both CLIs seen in this project (2.1.278, 2.1.283) have the flag.
- **CLI semantics drift.** If a future CLI makes MCP tools depend on `ToolSearch` even without it being in
  the set, the chat would lose its tools. The smoke test (step 4) is the guard; it is worth re-running when
  the CLI is upgraded.
- **Parallel agent versions.** Another branch may bump the agent too; whoever merges second takes the
  next patch number.
- **Container runner** keeps the old argv until its image is rebuilt (unused, §3).

## 7. Out of scope

- A server-side minimum agent version for the chat.
- `TaskStop` for cancelling subagents (TER-64/65).
- Ignoring the account's settings files (`--setting-sources`, `--restricted`).
