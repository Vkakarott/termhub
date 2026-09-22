# The concierge on the user's own machine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run each user's chat on a machine they own, under an AI account of theirs, instead of in one container on the operator's Claude account.

**Architecture:** `RunnerClient` already abstracts "something that runs the CLI and streams lines", and the agent protocol already streams over channels (`open`/`opened`/`closed`, today only `kind: 'pty'`). This adds a second channel kind, an agent-side handler that spawns the CLI, and a second `RunnerClient` that drives it — plus the data the chat needs to know which machine and which account are the user's. Nothing above `RunnerClient` changes: the gate, the cards, the busy lock, the fresh-session retry and the bus events are untouched.

**Tech Stack:** TypeScript across `packages/agent-protocol` (zod schemas), `apps/agent` (Node, ws), `apps/server` (Fastify 5, Prisma 7), `apps/web` (React 18, Tailwind 3), `apps/concierge` (the existing container). Vitest throughout.

**Spec:** `docs/superpowers/specs/2026-09-22-user-hosted-concierge-design.md` — read it first; it records the decisions this plan implements and the two it deliberately leaves open (§9, §10).

## Global Constraints

- **No new dependencies**, in any workspace.
- UI copy in pt-BR; code, comments, commit messages and PR text in English.
- **The CLI's restrictions are identical on both runners.** `--strict-mcp-config`, `--allowed-tools mcp__termhub__*` and `--disallowed-tools Bash,Read,Write,Edit,WebFetch,WebSearch` are what keep the model inside the gate; on a user's own machine they matter more, not less, because there the model would otherwise be one `Bash` away from their home directory. After Task 1 they exist in exactly one place, and both sides pin the exact argv.
- **The prompt never appears in argv and never reaches a log.** It goes in on stdin (a prompt starting with `-` must not become a flag, and argv is visible to every process on that machine). The same rule applies to the MCP token.
- **The protocol change is additive.** A server that knows `kind: 'claude'` must keep working with an agent that does not, and say so in a way the person can act on.
- The agent's version bump **is** the release: CI publishes `@termhub/agent` on merge (see CLAUDE.md). Never `npm publish` by hand.
- Green means: `npm test -w @termhub/server`, `npm test -w @termhub/web`, `npm test -w @termhub/agent`, `npm test -w @termhub/agent-protocol` (and the concierge's own suite), `npm run typecheck --workspaces --if-present`, and `npm run build -w @termhub/web`.
- Existing tests are the contract; none may be deleted or weakened.

## Review Focus

- **The host sleeps mid-answer.** A laptop that closes ends the channel with no `done` frame. This is the existing `RUNNER_FAILED` path, but it will now happen far more often than a container dying, so the message must say the machine went away rather than read as a bug. (Task 4.)
- **`claude` is not installed on the host.** The most likely first failure of the whole feature, and a generic "run failed" would send the person hunting. It gets its own reason, naming what to install. (Tasks 3 and 4.)
- **The agent is too old to know the channel.** Must read as an instruction with the update path, not an error. (Tasks 2 and 5.)
- **The machine or the account is deleted between two messages.** The next message asks the user to choose again instead of guessing a replacement. (Task 5.)
- **A prompt that starts with `-`, and a very large one.** Must reach the CLI intact through stdin, never argv. (Task 3.)

---

### Task 1: One place that builds the CLI's argv

**Files:**
- Create: `packages/claude-cli/package.json`, `packages/claude-cli/src/index.ts`, `packages/claude-cli/src/argv.test.ts`, `packages/claude-cli/tsconfig.json`
- Modify: `apps/concierge/src/run.ts` (builds its argv from the package), `apps/concierge/src/run.test.ts`
- Modify: `package.json` (workspaces), `docker/concierge/Dockerfile` (copy the new package's manifest, as it already does for each workspace)

**Interfaces:**
- Produces:
  ```ts
  export interface ClaudeRunSpec { session_id: string; resume: boolean; mcp_config_path: string; model?: string | null }
  /** Every flag the concierge must run with, in a fixed order. */
  export function buildClaudeArgs(spec: ClaudeRunSpec): string[];
  /** The MCP config file's contents, so both runners write the same shape. */
  export function mcpConfig(url: string, token: string): string;
  export const DISALLOWED_TOOLS: string;
  ```
  Tasks 3 and 4 both build from this and nothing else.

- [ ] **Step 1: Write the failing tests**

`argv.test.ts`:
1. The argv contains `--strict-mcp-config`, `--allowed-tools mcp__termhub__*`, `--disallowed-tools` with the exact six-tool string, `--output-format stream-json`, `--verbose` and `--include-partial-messages` — asserted as adjacent pairs, not as "contains somewhere", because a flag whose value drifted to another flag's slot is the bug this file exists to catch.
2. `resume: true` produces `--resume <id>` and **no** `--session-id`; `resume: false` produces `--session-id <id>` and no `--resume`. (The CLI rejects both together — this cost a production incident.)
3. A model is passed through when given and absent when not.
4. The prompt is nowhere in the argv, for any input — including a prompt that begins with `-`.
5. `mcpConfig` puts the token in the header and nowhere else, and is valid JSON with one server named `termhub`.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/claude-cli` — module not found.

- [ ] **Step 3: Implement, by moving**

Move the logic out of `apps/concierge/src/run.ts` verbatim; this task changes no behaviour. Keep the comments that explain *why* each flag is there — they record incidents.

- [ ] **Step 4: Point the concierge at it**

`run.ts` imports and uses it. Its own argv test keeps asserting the full command line it spawns, so the two files now agree by construction and still fail independently if either drifts.

- [ ] **Step 5: Green and commit**

The concierge suite and the new package's; `npm run typecheck --workspaces --if-present`.

```bash
git add packages/claude-cli apps/concierge package.json docker/concierge/Dockerfile
git commit -m "Web: one place that builds the concierge CLI's arguments"
```

---

### Task 2: A second channel kind in the protocol

**Files:**
- Modify: `packages/agent-protocol/src/messages.ts`
- Test: `packages/agent-protocol/src/messages.test.ts`

**Interfaces:**
- Produces: `serverMessage`'s `open` gains a `kind: 'claude'` variant with
  ```ts
  { session_id: string; resume: boolean; config_dir: string | null; mcp_url: string; token: string; model?: string | null }
  ```
  and `helloMessage` gains `capabilities: string[]` (optional, defaulting to `[]`), through which an agent says it understands `claude`. Task 3 answers it; Tasks 4 and 5 read the capability.

- [ ] **Step 1: Write the failing tests**

1. A well-formed `open` with `kind: 'claude'` parses, and its params keep their types.
2. An `open` with `kind: 'pty'` still parses exactly as before (the existing tests must not change).
3. An unknown `kind` is rejected.
4. `config_dir` accepts `null` (the machine's default account) and a path.
5. A `hello` **without** `capabilities` parses and yields `[]` — an old agent must not fail validation, which is the whole point of an additive change.
6. A `hello` with `capabilities: ['claude']` parses.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/agent-protocol`.

- [ ] **Step 3: Implement**

Extend the discriminated union. Comment why the token travels in the open frame rather than the channel: it is the user's own token going to the user's own machine, minted per run and revoked on the next.

- [ ] **Step 4: Green and commit**

```bash
git add packages/agent-protocol
git commit -m "Protocol: a channel kind for a headless Claude run"
```

---

### Task 3: The agent runs the CLI and streams it back

**Files:**
- Create: `apps/agent/src/claude/run.ts`, `apps/agent/src/claude/run.test.ts`
- Modify: `apps/agent/src/dispatch.ts` (routes `kind: 'claude'`), `apps/agent/src/dispatch.test.ts`
- Modify: `apps/agent/src/client.ts` (advertises the capability in `hello`)
- Modify: `apps/agent/package.json` (version bump — this is the release)

**Interfaces:**
- Consumes: `buildClaudeArgs`/`mcpConfig` (Task 1), the `claude` open params (Task 2).
- Produces: a channel manager with the same shape the PTY one has (`open(ch, params, socket)`, `close(ch)`), so `dispatch` routes to it without learning anything new.

- [ ] **Step 1: Write the failing tests**

Use the fake-CLI pattern from `apps/server/src/mcp/start-agent.e2e.test.ts`: a shell script on `PATH` that reports what it received. Do not spawn a real `claude`.

1. It spawns the CLI with the argv `buildClaudeArgs` produced, in an `env` where `CLAUDE_CONFIG_DIR` is the `config_dir` it was given — and with the process's own `CLAUDE_CONFIG_DIR` **not** leaking in when `config_dir` is null.
2. The prompt arrives on **stdin**, byte for byte, including a prompt that starts with `-` and one of 100 KB.
3. Each stdout line becomes one channel frame, and a line split across two chunks arrives as one frame (the fake writes a line in two `write` calls with a pause).
4. The channel ends with `closed` carrying the CLI's exit code.
5. `close` from the server kills the process — assert the child is gone, not merely that a function returned.
6. **A missing CLI is its own outcome:** with no `claude` on `PATH`, the channel reports a distinct reason rather than a generic failure, and says what is missing.
7. The token and the prompt appear in no log line the handler writes (spy the logger and assert both strings are absent from every call).

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/agent`.

- [ ] **Step 3: Implement**

Mirror the container's `runClaude` (`apps/concierge/src/run.ts`) — it already solved the ordering problems: stdin closed after the prompt, stderr collected but never forwarded, a timer that kills a run that overstays. Write the MCP config to a private temp dir with mode `0600` and remove it when the channel closes.

- [ ] **Step 4: Advertise the capability and bump the version**

`hello` carries `capabilities: ['claude']`. Bump `apps/agent/package.json`'s version in this commit: on merge, CI publishes it, and machines with auto-update pick it up within the hour.

- [ ] **Step 5: Green and commit**

```bash
git add apps/agent
git commit -m "Agent: run a headless Claude session and stream it to the server"
```

---

### Task 4: The server's second runner

**Files:**
- Create: `apps/server/src/chat/agent-runner.ts`, `apps/server/src/chat/agent-runner.test.ts`
- Modify: `apps/server/src/chat/runner.ts` (export both; no behaviour change to `httpRunner`)

**Interfaces:**
- Consumes: the agent connection registry (`apps/server/src/agent/connection.ts` — the same one `tmux.*` RPCs go through) and the `claude` channel from Task 2.
- Produces: `agentRunner(machineId: string): RunnerClient`, satisfying the interface `ChatService` already depends on.

- [ ] **Step 1: Write the failing tests**

Against a fake agent connection, not a real socket:

1. It opens a `claude` channel with the params derived from `RunnerInput`, and yields one string per line the agent sends.
2. A frame carrying two lines yields two strings; a line split across two frames yields one. (The container's reader already does this; the test is here because this reader is new code.)
3. `closed` with a non-zero exit ends the iteration — the service's existing "no `done` frame" rule then marks the run failed, which this test asserts by the absence of a `done`.
4. **The host went away mid-answer:** the connection drops with the channel open, and the iterator ends with a reason the service can turn into a message that names the machine.
5. **The agent is too old** (no `claude` capability): the runner refuses *before* opening anything, with a distinct reason, and never mints a channel.
6. Abandoning the iterator (the caller stops reading) closes the channel, so a machine is never left running a CLI nobody is listening to.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/server -- agent-runner`.

- [ ] **Step 3: Implement**

Keep `httpRunner` untouched. The deadline that `httpRunner` expresses with `AbortSignal.timeout` becomes a `close` on the channel.

- [ ] **Step 4: Green and commit**

```bash
git add apps/server/src/chat
git commit -m "Chat: a runner that drives the CLI on the user's own machine"
```

---

### Task 5: Which machine, which account, and what to say when there is neither

**Files:**
- Create: `apps/server/prisma/migrations/<timestamp>_chat_host/migration.sql`
- Modify: `apps/server/prisma/schema.prisma`, `apps/server/src/db/repositories/chat.ts`
- Create: `apps/server/src/chat/host.ts`, `apps/server/src/chat/host.test.ts`
- Modify: `apps/server/src/chat/service.ts` (picks the runner), `apps/server/src/routes/chat.ts` (exposes and sets the host)
- Modify: `apps/server/src/app.ts` (drops the `secondary` config dir)

**Interfaces:**
- Produces:
  ```ts
  export type HostChoice =
    | { kind: 'ready'; machine: Machine; configDir: string | null }
    | { kind: 'no_machine' } | { kind: 'not_chosen'; machines: Machine[] }
    | { kind: 'offline'; machine: Machine } | { kind: 'agent_too_old'; machine: Machine; version: string };
  export function resolveHost(ctx, user): Promise<HostChoice>;
  ```
  Every outcome carries what the message needs to be specific; Task 6 renders them.

- [ ] **Step 1: Write the failing tests**

`host.test.ts`:
1. One machine, online, agent current → `ready`, and it is that machine, with no question asked of the user.
2. Several machines and none chosen → `not_chosen`, listing them.
3. A chosen machine that is offline → `offline`, naming it — **not** a fallback to the container, which the spec refuses.
4. A chosen machine whose agent lacks the capability → `agent_too_old`, carrying the version.
5. No machines at all → `no_machine`.
6. The chosen machine was deleted → behaves as if never chosen, rather than resolving to a machine of someone else's or throwing.
7. The chosen `ai_account` was deleted → `ready` with `configDir: null` (the machine's default account), not a failure.
8. The account's `config_dir` is honoured when set, and `null` means the default.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/server -- host`.

- [ ] **Step 3: The migration and the column**

`chat_conversations` gains `ai_account_id` (nullable, `ON DELETE SET NULL`); `machine_id` starts being used. Write it as SQL that is safe to run twice, like the repo's other data migrations.

- [ ] **Step 4: Wire the service**

`ChatService` asks `resolveHost` and uses `agentRunner(machine.id)`; anything other than `ready` fails the send **before** an assistant row is written, with the reason in the error's code, so the browser shows a sentence and not an empty bubble. Drop `secondary` from the constructor and from `app.ts`.

- [ ] **Step 5: Green and commit**

```bash
git add apps/server
git commit -m "Chat: choose the machine and the account that run the conversation"
```

---

### Task 6: Saying it on screen

**Files:**
- Modify: `apps/web/src/pages/ChatPage.tsx`, `apps/web/src/lib/types.ts`, `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/chat/ChatHost.tsx`, `apps/web/src/components/chat/ChatHost.test.tsx`
- Test: `apps/web/src/pages/ChatPage.test.tsx`

**Interfaces:**
- Consumes: the `HostChoice` shapes from Task 5, as the chat endpoint now returns them.

- [ ] **Step 1: Write the failing tests**

1. **No machine:** the chat does not pretend to work. It states that the conversation runs on a machine of the person's own and needs one set up, and offers the way to enrol it. The composer is disabled, with that as the reason. (This is the spec's honest limit: with no machine the concierge has nothing to orchestrate.)
2. **Not chosen:** the machines are listed and picking one sets the host.
3. **Offline:** the message names the machine and offers to change the host — it must not read as a bug in the chat.
4. **Agent too old:** the message names the version and points at the update, and reads as an instruction rather than a failure.
5. **Ready:** the header shows which machine and which account are running the conversation — the person should never have to guess whose computer is thinking.
6. **Changing the host warns first**, in one sentence, that the model's session memory starts over and the transcript stays, and does nothing until the person confirms.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- ChatHost ChatPage`.

- [ ] **Step 3: Implement**

`ChatHost` is presentational: every decision arrives as props, as `ChatTurn` and `ChatActionCard` do. Keep the strings short — this screen is read on a phone.

- [ ] **Step 4: Green and commit**

`npm test -w @termhub/web`, the workspace typecheck, and `npm run build -w @termhub/web`.

```bash
git add apps/web/src
git commit -m "Chat: say which machine is thinking, and what to do when there is none"
```
