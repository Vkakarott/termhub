# Codex monitor hooks (TER-356) — plan

Spec: `docs/superpowers/specs/2026-09-29-codex-monitor-hooks-design.md` (read it: D1–D8 are binding).

## Global constraints

- TDD: write the failing test first, watch it fail, then the code. Vitest.
- Code comments / identifiers in English; UI copy in pt-BR. Match the surrounding comment density and style (these files explain *why* in prose comments).
- Terminal content is never logged; the hook script never forwards a tool's input except where the spec says so (Codex `PermissionRequest`, D2).
- Never run `npm test -w @termhub/agent` for the whole agent suite without the repo's guard in place (it exists: `apps/agent/src/test-setup.ts`); running specific test files is fine.
- Commands, from the worktree root `/Volumes/Extra/projects/8020/termhub/.claude/worktrees/ter-356-codex-hooks`:
  - machine-ops: `npm test -w @termhub/machine-ops` then `npm run build -w @termhub/machine-ops` (the server and agent import its `dist`, so rebuild after changing it).
  - server: `cd apps/server && DATABASE_URL=postgresql://x:x@localhost:5432/x npx vitest run <files>`; typecheck `npm run typecheck -w @termhub/server`.
  - agent: `cd apps/agent && npx vitest run <files>`; typecheck `npm run typecheck -w @termhub/agent`.
  - web: `cd apps/web && npx vitest run src/components/MonitorHooksCard.test.tsx`.
- Commit per task, English imperative subject ≤ 72 chars, body with the why. End every commit message with:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- Real payload samples are in the spec §2 — use them as test fixtures.

## Task 1: machine-ops — Codex hooks.json merge/strip and the hook script

Files: `packages/machine-ops/src/hooks.ts`, `packages/machine-ops/src/hooks.test.ts`, `packages/machine-ops/src/hook-script.test.ts` (read how it executes the script with a fake `tmux`/`curl` before adding cases), `packages/machine-ops/src/index.ts` if exports are listed there.

1. `export const CODEX_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt'] as const;` with a doc comment (spec D1: why these, why no SessionStart, why Interrupt timeout 3, trust note).
2. `export const CODEX_HOOKS_REL = '.codex/hooks.json';`
3. `mergeCodexHooks(current: string, scriptPath: string, shown = '~/.codex/hooks.json'): string` — same contract as `mergeClaudeSettings` (throws `"<shown> não é um objeto JSON"` / `"<shown>: o campo \"hooks\" não é um objeto"`, keeps other keys and the person's entries, replaces our old entry, output `JSON.stringify(x, null, 2) + '\n'`). Our entry per event: `{ hooks: [{ type: 'command', command: '<scriptPath> codex', timeout }] }`, plus `matcher: '*'` for `PreToolUse`, `PermissionRequest`, `PostToolUse`; `timeout` 3 for `Interrupt`, 10 otherwise. Factor the shared merge with `mergeClaudeSettings` (events + per-event matcher/timeout as parameters) rather than duplicating it; `mergeClaudeSettings`'s output must stay byte-identical (its tests must pass unchanged).
4. `stripCodexHooks(current: string): string` — same as `stripClaudeSettings` (reuse it: identical format). Also `isBareCodexHooks(body)`: true when nothing is left but an empty object `{}` (what strip leaves of a file we created), so uninstall can delete it — mirror `isBareCursorHooks`' contract (empty/unparseable → false).
5. Hook script (`HOOK_SCRIPT`), spec D2:
   - `if [ "$TOOL" = codex ] && [ -n "$2" ]; then EVENT="$2"; else EVENT=$(cat 2>/dev/null); fi` (notify passes argv; hooks pass stdin).
   - `PreToolUse | PostToolUse)` share the branch; the reduced body keeps the event's own name (`"hook_event_name":"$KIND"`). The AskUserQuestion exception stays PreToolUse-only.
   - `PermissionRequest)`: when `$TOOL = codex`, after validating NAME as today, clear the marker (`rm -f "$MARK"`) and leave `EVENT` whole (do not reduce); for Claude, unchanged.
   - Update the header comment (mentions `~/.codex/hooks.json`) and the comments of the touched branches.
   - Tests (hook-script.test.ts): codex notify via argv still posts the argv JSON; codex PreToolUse on stdin posts the reduced body with `"tool":"codex"`; PostToolUse reduced + deduped against a previous PreToolUse of the same tool; codex PermissionRequest posts the whole event and a following PostToolUse of the same tool is posted (marker cleared); Claude PermissionRequest still reduced (existing test). stdout stays empty.

## Task 2: installers — agent and ssh/local write/strip ~/.codex/hooks.json

Files: `apps/agent/src/rpc/hooks.ts` (+ `hooks.test.ts`), `apps/server/src/monitor/install.ts` (+ `install.test.ts`), `apps/agent/package.json` (version `0.10.1` → `0.11.0`), and the agent's version constant/test if one mirrors package.json (grep `0.10.1` in `apps/agent/src`).

- Agent `install`: when `~/.codex` exists, besides the notify merge, merge `~/.codex/hooks.json` (`readNamed`, refuse unparseable before writing anything — same shape as `mergedCursorHooks`, message `~/.codex/hooks.json não é JSON válido`, RpcFailure path `.codex/hooks.json`) and write it atomically 0o644. Result `codex` stays `'installed' | 'skipped'`.
- Agent `heal` / `healCodex`: keep the notify rule as is; also merge hooks.json and write only when it changed (like `healCursor`); a failure on hooks.json must not stop the notify repair or vice versa; answer `~/.codex` once if either was repaired.
- Agent `uninstall`: strip our entries from hooks.json; delete the file when `isBareCodexHooks`; unparseable → left alone.
- Server `install.ts` (ssh/local, one round trip): probe `"$HOME/.codex/hooks.json"` in the Codex section like the other files (absent/present/unreadable); an unreadable one is listed with the others (`~/.codex/hooks.json`); merge/write via `replaceFile`; strip on uninstall (and remove when bare — follow how the Cursor file is removed there, if it is; otherwise write the stripped body).
- Tests for each path, following the existing test style in those files.

## Task 3: server monitor — interpret Codex hooks, one alert per turn

Files: `apps/server/src/monitor/state.ts` (+ `state.test.ts`), `apps/server/src/monitor/wait-decision.ts` (+ `wait-decision.test.ts`), and wherever `decideWait`'s drop outcome is consumed (`apps/server/src/db/repositories/tabs.ts` — check the `drop` reason type is used generically; `tabs.db.test.ts` needs a DB, don't run it).

- `interpretCodex` (spec D3): branch on `hook_event_name` when present; the notify path unchanged. `UserPromptSubmit` → `{ kind: 'working', text: null, meta: { event } }`; `PreToolUse`/`PostToolUse` → working + `activity: activityOf(tool)`, `verb: null`, `meta: { event, tool }`; `PermissionRequest` → `waiting_permission`, text = capped `tool_input.description` (string, trimmed) or `O Codex precisa da sua permissão para usar ${tool}` (tool validated with `parsePermissionTool`; no valid tool → text `O Codex precisa da sua permissão`), meta `{ event, tool }`, **no `question`**, and never anything of `tool_input` besides `description` in text/meta; `Stop` → `waiting_input`, text capped `last_assistant_message`, meta `{ event: 'Stop' }`; `Interrupt` → `waiting_input`, text null, meta `{ event: 'Interrupt' }`; anything else → null. Subagent flag like `interpretClaude` (reuse `isSubagent`).
- Update `interpretCodex`'s doc comment (it currently says Codex has no permission notification).
- `decideWait` (D4): when `event.kind === 'waiting_input'`, `current.state === 'waiting_input'`, and `history[0]` is a row whose event is the partner (`Stop` ↔ `agent-turn-complete`) with `ageMs <= REORDER_WINDOW_MS`, return `{ action: 'record', seen: current.seen ? 'carry' : 'none', continuing: true }`. Two `agent-turn-complete`s in a row stay `NEW`; an old partner (> window) stays `NEW`.
- `decideWait` (D5): an event `{ kind: 'working', name: 'PostToolUse' }` while `current.state === 'waiting_input'` → `{ action: 'drop', reason: 'post_tool_after_interrupt' }` (extend the reason union; make sure the consumer and `ingest.ts` treat it as dropped — ingest already returns `ignored` on `recorded.dropped`). Check the light path in `ingest.ts` `recordInterpretation`: it only runs when the tab is `working`, so a PostToolUse on a `waiting_input` tab reaches `recordState` → `recordEvent` → `decideWait`. Verify that.
- Tests: interpreter cases from the spec §2 samples (including that `tool_input.command` never appears in the result), decideWait pair both orders, window edge, notify-notify stays new, PostToolUse drop, PostToolUse from `waiting_permission` is recorded working.

## Task 4: Codex tab MCP on, install note, docs

Files: `apps/server/src/control/agents.ts`, `apps/server/src/control/agents.test.ts`, `apps/server/src/mcp/start-agent.e2e.test.ts` (DB e2e — update its expectation, it runs only in CI), `apps/web/src/components/MonitorHooksCard.tsx` (+ test), `docs/superpowers/specs/2026-09-27-agent-tab-mcp-design.md`, new lesson `docs/lessons/2026-09-29-codex-hooks-need-trust.md`.

- `CODEX_TAB_MCP_ENABLED = true`, doc comment: verified on hulk with codex-cli 0.159.2 (`codex mcp list` shows `termhub_tab` / Bearer token). Update the unit test that asserted `false` so it covers what a Codex tab now gets (mint + Codex MCP line) and the e2e expectation that looked for `o MCP no Codex ainda não foi verificado`. Remove the `codex_unverified` reason only if nothing else uses it; otherwise leave it.
- `hooksInstallNote`: when `codex === 'installed'`, `Codex: ok (abra o Codex uma vez e confie nos hooks)` — test first.
- Spec 2026-09-27 D9 / §8: short note that it was verified on 2026-09-29 and enabled (TER-356).
- Lesson (format in `docs/lessons/README.md`): symptom `Codex tab never reports working or waiting_permission` / "Hooks need review" on launch; cause: Codex runs hooks only after the person trusts them (`hooks.state.*.trusted_hash` in config.toml); fix: open Codex once on the machine and choose Trust all (or /hooks); how to check: the tab goes `working` on the next prompt. card TER-356, agent claude, date 2026-09-29, evidence fixed.
