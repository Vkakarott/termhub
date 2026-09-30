# Codex in the tab monitor: working, waiting_input, waiting_permission (TER-356)

## 1. Problem

Codex tabs report only through `notify` (`agent-turn-complete`): the monitor, and the concierge that
reads it, see a Codex tab as `waiting_input` at the end of a turn and nothing else. It never knows that
Codex is working, and a Codex tab stopped on an approval menu looks exactly like one still working.

TER-356 also asked to verify on hulk (the only machine with Codex) the tab memory MCP that
`start_agent` gives a Codex tab (spec 2026-09-27 agent tab MCP D9), disabled until then behind
`CODEX_TAB_MCP_ENABLED`.

## 2. What Codex offers (checked against codex-cli 0.159.2 on hulk, 2026-09-29)

- Hooks are a stable feature (`codex features list`: `hooks stable true`). Codex reads them from
  `~/.codex/hooks.json` in the same shape as Claude Code's settings (`{"hooks": {"<Event>": [{"matcher"?,
  "hooks": [{"type": "command", "command", "timeout"}]}]}}`) and from `[[hooks.<Event>]]` in
  `config.toml`. Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
  `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.
- Payloads come on **stdin**, Claude-shaped, `hook_event_name` after `session_id` / `turn_id` /
  `transcript_path` / `cwd`; `tool_name` before `tool_input`. Captured:
  - `UserPromptSubmit` `{…, "prompt": "…"}`
  - `PreToolUse` `{…, "tool_name": "Bash", "tool_input": {"command": "…"}, "tool_use_id": "exec-…"}`
  - `PermissionRequest` `{…, "tool_name": "Bash", "tool_input": {"command": "…", "description": "Allow creating hello.txt …? The workspace sandbox is read-only."}}` — `description` is the question Codex shows above the approval menu.
  - `PostToolUse` `{…, "tool_name": "Bash", "tool_input": {…}, "tool_response": "…", "tool_use_id": "…"}`
  - `Stop` `{…, "stop_hook_active": false, "last_assistant_message": "…"}`
  - `Interrupt` `{…, "hook_event_name": "Interrupt", "model", "permission_mode"}` — sent on Esc, during a
    turn or on an approval menu; **no `Stop` and no `notify` follow it**. When the Esc denied an
    approval, the tool's `PostToolUse` can arrive *after* the `Interrupt`.
  - Codex clamps an `Interrupt` hook's timeout to 3 s (a startup warning otherwise).
- At the end of a normal turn both fire: the `Stop` hook and then `notify` (`agent-turn-complete`, whose
  `turn-id` is the `Stop`'s `turn_id`). The side turn that names a new conversation fires `notify` only.
- **Hooks need the person's trust.** A new or changed hook makes the Codex TUI open "Hooks need review"
  on launch (Review / Trust all / Continue without trusting); the trust is stored in `config.toml` as
  `[hooks.state."<file>:<event>:<group>:<handler>"] trusted_hash = "sha256:…"`. termhub does **not**
  write that trust: it is Codex's safety review of commands that run outside its sandbox, and it is the
  person's call. Until they trust the hooks, Codex runs none of them and `notify` (which needs no trust)
  keeps reporting the end of each turn, as today.

## 3. Decisions

| # | Decision |
|---|----------|
| D1 | Install writes our entries into `~/.codex/hooks.json` (merged, the person's entries kept, the same merge the Claude settings use) for `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `Interrupt`, and keeps the `notify` line in `config.toml`. `hooks.json` and not `config.toml`: appending `[[hooks.X]]` tables can make a `config.toml` that defines `hooks` inline unparseable, which stops Codex from starting at all. Tool events get `matcher: "*"`; `Interrupt` gets `timeout: 3`, the rest 10. No `SessionStart`: it fires at launch with nobody's turn behind it and would read as working. |
| D2 | The hook script reads a Codex payload from argv when there is one (`notify`) and from stdin otherwise (hooks). `PostToolUse` is reduced on the machine exactly like `PreToolUse` (tool name only, same dedupe marker). A Codex `PermissionRequest` travels whole — its `description` is the question, written to be shown to the person (same reasoning as AskUserQuestion) — and the server keeps only `tool_name` and `description`, never the command. A Codex `PermissionRequest` also clears the dedupe marker, so the approved tool's `PostToolUse` gets through and says the tab is working again. Claude's branches do not change. |
| D3 | Server, `interpretCodex`: `UserPromptSubmit` → `working`; `PreToolUse` / `PostToolUse` → `working` with the tool's activity; `PermissionRequest` → `waiting_permission` with `description` (capped) as text, or `O Codex precisa da sua permissão para usar <tool>` without one; `Stop` → `waiting_input` with `last_assistant_message`; `Interrupt` → `waiting_input`, no text; `notify` as today. A subagent's event (`agent_id` / the script's `subagent` flag) is flagged like Claude's. No chat question card for a Codex permission: answering one types into Claude's dialog layout (`permission-dialog.ts`), which Codex's menu does not share. |
| D4 | One finished turn, one alert: a Codex `Stop` and its `notify` are the same wait. In `decideWait`, a `waiting_input` named `agent-turn-complete` that lands while the tab is `waiting_input` and its last row is a `Stop` less than `REORDER_WINDOW_MS` old (or the other way round) continues that wait (`carry` / `continuing`). Only the pair across the two names: two `notify`s in a row (a machine whose hooks are not trusted) stay two waits. |
| D5 | A `PostToolUse` that lands while the tab is `waiting_input` is dropped: it is the late tail of an Esc (`Interrupt` already ended the turn), not a turn starting. |
| D6 | The agent (`hooks.install`, `heal`, `hooks.uninstall`) and the ssh/local path (`monitor/install.ts`) write and strip `~/.codex/hooks.json` with the same `@termhub/machine-ops` functions. `heal` adds our entries when they are missing (the merge is a no-op otherwise), like it does for Cursor. Agent version bumped: the script it bundles changed. |
| D7 | The machine form's install note says that Codex asks to review the hooks the next time it opens. |
| D8 | `CODEX_TAB_MCP_ENABLED = true`: codex-cli 0.159.2 accepts `-c mcp_servers.termhub_tab.url=…` and `-c mcp_servers.termhub_tab.bearer_token_env_var=…` (`codex mcp list` shows `termhub_tab`, Bearer token). |
