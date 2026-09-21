# Chat concierge (the global terminal as a conversation) — design

Date: 2026-09-20. Status: approved in conversation (Pedro), section by section; implementation
follows this document. Supersedes the open questions of
`2026-09-19-mobile-chat-concierge-brainstorm.md` for the web client, and extends
`2026-09-18-global-terminal-mcp-design.md`, which shipped in #58, #63, #66, #70, #71, #72, #73.

## 1. Why

The global terminal works, but the only way in is an MCP client: a Claude Code session with a
`thb_pat_…` token. Asking "what is opapingou waiting for?" means having a terminal open and an
agent session running somewhere.

What the user asked for is the same power as a conversation: **type something, the global
terminal underneath receives it, works, checks whether the action needs permission, writes an
answer, and replies in the chat.** One chat for everything, in the app they already have open.

Success: a normal working day resolved from the chat — ask what a project is waiting on, send
work to a machine, read the summary — with the terminal tabs still there for when the user wants
to take the keyboard. And the chat gets *less* talkative over time, because it learns which
actions this user always approves.

## 2. Decisions

| Question | Decision |
|---|---|
| Client for v1 | **Web**, inside the app (session cookie, no new auth). The conversations API is client-agnostic so the mobile app of the earlier brainstorm reuses it and only adds device pairing. |
| Scope of a conversation | **One conversation for the whole account.** The concierge resolves machines and projects by name through `find`. `machine_id` / `tab_id` stay on the table, nullable, so per-machine and per-tab chats can come later without a migration. |
| Engine | **Claude Code headless**: `claude -p` with `--session-id` / `--resume`, `--output-format stream-json`, the termhub MCP attached. The reply text is the model's own — nothing is scraped from a TUI. |
| Where it runs | A **new container on jarvis** (`concierge`), with the CLI in the image and the account config dirs mounted. Not the app container (no CLI there, uid 100, replaced on every blue/green deploy) and not the agent (that would mean a new RPC, a stream channel and an agent that can run an LLM). |
| Account | jarvis's Claude accounts, ordered by a new `concierge_rank`; primary is `~/.claude_pedrogoiania`, secondary `~/.claude`. Credit is checked before the run and again reactively if the CLI reports a limit. |
| Model | **Per-conversation setting, default = the account's own default.** No silent downgrade. |
| Answer in the chat | **Streamed, with a visible trail of actions** ("read the screen of tab X", "started Claude in reactivando"). The trail comes free from `stream-json` and is also the audit the user reads. |
| Permission gate | Lives at the **MCP boundary**, in the server — not in the CLI. Reads never ask; reversible writes go through a gate that learns; irreversible actions always ask. |
| Waiting for an answer | **Durable, not a held request**: the pending action is a row, and every tool call starts by looking for pending work (user's design, §5.2). |
| Memory | Every exchange and every decision is stored **and embedded**: pgvector in the app's own Postgres, embeddings from a small local container. Chat text and action arguments are stored in full; captured screens and command output never are. |

## 3. Architecture

Four pieces; two of them already exist.

1. **Chat screen (web, new).** One conversation, message history, action trail, confirmation
   buttons. The server keeps one conversation per user (get-or-create on first load); the table
   allows several so the later modes fit without a migration. Authenticated by the session cookie
   the app already uses. UI copy in pt-BR.
2. **Conversations API (server, new).** `POST /api/chat/messages` persists the user's message and
   asks the runner to work; `/ws/chat` streams tokens, actions and confirmation requests back,
   following the pattern of `/ws/monitor`. The server owns all persistence — the runner never
   touches the database.
3. **Concierge runner (new container, jarvis).** Holds the Claude Code CLI and the mounted config
   dirs, exposes an internal-only endpoint (`POST /run`, NDJSON response) on the compose network,
   and streams the CLI's `stream-json` frames back as they come. Same role in the stack as
   `termhub-whisper`: a small sidecar with one job. Not rebuilt by a blue/green deploy, so a
   conversation survives one.
4. **`POST /mcp` (already in production)** with a token of its own for the concierge.

### 3.1 The path of one message

```
web → POST /api/chat/messages → chat_messages(role=user)
    → runner POST /run {conversation, session_id, text, config_dir, model?}
        → claude -p … --mcp-config termhub → tool call → POST /mcp (server)
            → gate (§5) → control layer → agent RPC → machine
        ← stream-json frames (text deltas, tool_use, tool_result, usage)
    ← server parses frames → chat_messages(role=assistant) + chat_actions + /ws/chat
```

The loop is worth noticing: the concierge's actions come **back into the same server** as MCP
calls. That is what lets the gate live in one place instead of inside the CLI.

## 4. The runner

### 4.1 Command

Every value is fixed argv, nothing goes through a shell:

```
CLAUDE_CONFIG_DIR=<account config dir> claude -p
  --session-id <conversation uuid> [--resume <conversation uuid>]
  --output-format stream-json --include-partial-messages
  --mcp-config /etc/concierge/termhub-mcp.json --strict-mcp-config
  --allowed-tools "mcp__termhub__*"
  --disallowed-tools Bash,Read,Write,Edit,WebFetch,WebSearch
  [--model <model>]
```

`--session-id` lets the server choose the id, so no id is ever parsed out of the output.

The `mcp__termhub__*` wildcard in `--allowed-tools` is to be confirmed against the installed CLI
during implementation; if it is not honoured, the tools are enumerated one by one, which the server
can generate from the same list `tools/list` already exposes.

**The concierge has no local tools, and this is a security property, not a preference.** The risk
is not that it would reach the machines behind the gate's back — a call to `/mcp` from inside the
container passes the same server-side gate, and the container has no ssh, no tmux socket and no
agent connection. The risk is what sits in the container with it. Both account config dirs are
mounted read-write (the CLI refreshes its own token), so a local shell turns any text the model
reads off a terminal screen — a cloned repository's README, the output of a `curl` — into three
things: an OAuth credential it can exfiltrate over the internet the CLI needs anyway; a
`settings.json` it can write in those dirs, whose hooks then run **on the host** under the user's
own account the next time they use that config dir; and lateral reach to `db` and `app` on the
compose network, which the gate never sees. A fourth cost is not security but product: anything
done through a local tool appears in neither the chat's action trail nor `api_token_events`, so
"everything it did is in the history" stops being true.

Giving it a shell later is therefore a change to what is mounted beside it, not just a flag: a
Claude account of its own rather than the user's, and a read-only `settings.json`.
`--strict-mcp-config` keeps the user's other MCP servers out of the process.
`--dangerously-skip-permissions` is never passed — the same rule the global terminal spec already
sets for `start_agent`.

### 4.2 Account and credit

The Claude accounts of jarvis get a nullable `concierge_rank`; the server tries them in that
order. Before running, it reads usage through `apps/server/src/ai/*` (5 h and 7 d windows, 60 s
cache) and skips an account with no credit. If a run still comes back reporting a limit, the
server switches to the next account and retries the message **once**.

Claude Code keeps its sessions **inside the account's config dir**, so switching accounts cannot
continue a session — it does not exist on the other side. When that happens the server opens a
new session and primes it with a short recap built from `chat_messages`, and the chat says so:
"troquei para a conta secundária e retomei o contexto resumido". Pretending continuity would make
the concierge answer without knowing what the conversation was about.

### 4.3 Model

`chat_conversations.model` (nullable) is passed as `--model` when set; unset means the account's
own default. The concierge orchestrates rather than writes code, so a cheaper model stretches the
subscription — but that is the user's call per conversation, never a silent downgrade.

## 5. The gate

### 5.1 Classes

| Class | Tools | Behaviour |
|---|---|---|
| Read | `list_machines`, `list_projects`, `list_tabs`, `list_ai_accounts`, `find`, `read_screen`, `wait_for_state`, `list_tasks` | never asks |
| Reversible write | `open_tab`, `send_input`, `run_command`, `start_agent`, `create_task`, `add_subtasks`, `update_task`, `move_task` | the gate that learns (§6) |
| Irreversible | `close_tab`, `delete_task`, `send_key` with `C-c` / `Escape` on a tab whose agent is working | always asks; learning never applies |

The floor under the third class is deliberate: the cost of a mistake there does not fall with
experience, so there is nothing to learn.

### 5.2 Pending confirmations (durable)

The server does not hold the tool call while the user decides — `/mcp` has a 120 s
`proxy_read_timeout` in nginx, and a blue/green deploy mid-wait would lose the question.

1. A gated tool call arrives. The server computes
   `idempotency_key = hash(conversation_id, tool, normalised args)` and looks for a row.
2. **Row `approved`** → execute it, mark `executed`, return the result.
3. **Row `pending`** → do not ask again; return "ainda aguardando sua confirmação".
4. **Row `denied` / `expired`** → return a tool error saying the user did not authorise it. The
   model reads that and carries on (or explains).
5. **No row** → for a gated class, insert `pending`, push the question to `/ws/chat`, and return
   "pendente de confirmação, não execute agora". The turn ends there; the chat shows the button.
6. When the user answers, the server records the decision and **re-injects** into the same
   `--resume` session: "o usuário aprovou X, siga" (or denied). The tool call comes back, step 2
   executes it.

A `pending` row with no answer becomes `expired` after 24 h. Every transition is a row, so a
restart, a deploy or a dead CLI process loses nothing.

## 6. Learning

For every action in the reversible class, before executing:

1. Render the decision text: the user's current message + tool + target (machine, project, tab) +
   the real arguments.
2. Embed it and search `chat_memories` for the nearest neighbours **of the same tool** — the
   embedding judges the *request*, the tool is matched exactly. Otherwise "I approved running
   tests" would leak into "delete the task".
3. Score: an approval is `+1`, a denial is `−3`. A close enough denial **vetoes** auto-approval
   outright rather than just lowering the score: once the user has said no to something, the
   question comes back.
4. Above the threshold and no close denial → execute and record `decision = auto`. Otherwise →
   §5.2 and ask.

Starting values — **configuration, not constants**, and explicitly a guess to calibrate against
real data: cosine similarity ≥ 0.80, k = 8 neighbours, 3 concordant approvals, denial weight −3.
With an empty memory nothing clears the bar, which is exactly the "verbose at first, quieter as it
learns" behaviour the user asked for.

Two things keep this usable rather than magic:

- **Every auto action says why it did not ask** — "você já aprovou 3 pedidos parecidos" — linking
  the decisions it used.
- **Two escapes:** "esquece isso" deletes the memories behind a decision, and a *modo revisão*
  switch forces every write to ask again.

## 7. Data model

Four new tables, all additive, plus the `vector` extension (the DB image becomes
`pgvector/pgvector:pg16`) and `ai_accounts.concierge_rank Int?`.

- **`chat_conversations`** — `id`, `user_id` (FK, cascade), `title?`, `cli_session_id?` (uuid for
  `--resume`), `model?`, `machine_id?`, `tab_id?` (both nullable, both unused in v1),
  `review_mode Boolean @default(false)`, `last_message_at`, `created_at`.
- **`chat_messages`** — `conversation_id`, `role` (`user` | `assistant`), `text` (full),
  `usage Json?` (what `stream-json` reports), `error_code?`, `created_at`.
- **`chat_actions`** — `conversation_id`, `message_id?`, `tool`, `args Json` (the real arguments),
  `machine_id?`, `project_id?`, `tab_id?`, `idempotency_key?`,
  `class` (`read` | `write` | `irreversible`), `decision` (`auto` | `asked`), `status`
  (`pending` | `approved` | `denied` | `expired` | `executed` | `failed`), `reason?` (why it did
  not ask), `error_code?`, `duration_ms?`, `created_at`, `decided_at?`.
- **`chat_memories`** — `user_id`, `kind` (`decision` | `exchange`), `text`,
  `embedding vector(768)`, `embed_model` (which model produced the row), `conversation_id`,
  `action_id?`, `decision?`, `weight`, `created_at`; HNSW index on `embedding`.

`idempotency_key` is set only for gated actions, and uniqueness is a **partial** index on
`(conversation_id, idempotency_key) where status in ('pending', 'approved')`. A plain unique index
would be wrong: the trail also holds read actions, and reading the same tab twice in one
conversation is normal, not a duplicate.

`api_token_events` stays the raw, metadata-only audit of `/mcp`; `chat_actions` is the
conversation's own view and state machine, which the other table cannot represent.

### 7.1 What is stored and what is not

Stored in full: the chat messages, and each action's arguments — the command to be typed, the
prompt to start an agent with, the target. That is what the user approves, and without it the
learning is blind: "you approved `send_input` on m3" cannot tell `npm test` from `rm -rf`.

Never stored: **what the machine prints.** Captured screens (`read_screen`), `run_command` output,
PTY bytes. Two reasons, and the second is the stronger one: the project's rule that terminal
content is never logged, and the fact that this text is the prompt-injection surface — a cloned
repository's README or the output of a `curl` could be trying to give the concierge orders.
Embedding it would make poisoned text into training material. The model's own prose about a screen
("o teste falhou por conexão recusada") is stored, because it is the model's, not the machine's.

This is a **conscious deviation** from §3.1 of the global-terminal spec, which says typed text and
prompts are never stored. It is scoped to the chat's own tables; `api_token_events` is unchanged.

### 7.2 Embeddings

A small local container (the `termhub-whisper` pattern) exposes `POST /embed` on the compose
network; nothing leaves the server, there is no per-message cost, and the corpus is small. The
column is declared `vector(768)`, the width of the small multilingual sentence models this is
sized for; the exact model is chosen in the implementation plan, and if it has another width the
migration changes that one number. Changing the model later means re-embedding, so every row
records the `embed_model` that produced it.

`POST /run` and `POST /embed` are reachable only inside the compose network and both require a
shared secret from the environment, so anything else that lands on that network cannot drive the
concierge.

## 8. Errors and limits

- **One message in flight per conversation**; a second waits. A conversation is serial by nature.
- **10 min timeout per message** (configurable). On timeout the assistant message is `failed` with
  a reason and the chat says it did not finish — no invented answer.
- **40 tool calls per turn**, on top of the token's existing 120 calls/minute, so a runaway loop
  cannot burn the subscription.
- **Offline machine**: the tool already fails within 10 s ("A máquina não respondeu"); the
  concierge reports it like any other fact.
- **Revoked token or `/mcp` down**: tools disappear or answer 401; the server recognises this and
  says so in the chat instead of letting the concierge grope around.
- **Observability**: the number that matters is the share of `auto` versus asked actions over
  time — it shows whether the gate is really shrinking. Logs never carry terminal content;
  `usage` per message shows what a conversation cost.

## 9. Testing

The pattern is the one used for `start_agent` in #72: fake what is expensive, keep real what is
being tested.

- **Unit**: the gate policy (classes, scoring, denial veto, idempotency dedupe) against a fake
  memory; account selection (rank, usage, reactive fallback); the runner argv asserted exactly,
  including the absence of `--dangerously-skip-permissions` and the presence of
  `--disallowed-tools`.
- **`stream-json` parser**: frames into messages and actions, including a partial frame and an
  error frame.
- **Integration**: `POST /api/chat/messages` against a **fake runner** — a script that emits
  recorded NDJSON frames. Covers the conversation, the trail, a pending confirmation, the
  approval and the resume. No CLI login, runs in CI.
- **Gate through `/mcp`** (`fastify.inject`): a gated write returns "pending" and inserts one row;
  approving makes the next call execute; denying returns a tool error; repeating the call creates
  no second row.
- **pgvector**: a deterministic stub embedder (text → fixed vector) so CI does not need the model
  container.
- **Web**: the chat screen against a fake WS.

## 10. Out of scope

Per-machine and per-tab conversations (the data model is ready for them); voice input (the
`termhub-whisper` container exists, but the chat is text in v1); the mobile app and device
pairing; concierge on machines other than jarvis; letting a non-admin role use the `terminals`
scope (the permission matrix still lacks a `write` column — known limitation, recorded in the
README); automatic model or effort tuning; sharing a conversation with another user.

## 11. Delivery order

Each step deploys on its own.

1. **Conversations, read-only.** `chat_conversations`, `chat_messages`, the runner container, the
   API and the chat screen, with a concierge token limited to the `read` scope. Already useful:
   "what is running?", "what is opapingou waiting for?". No gate, because nothing writes.
2. **Gate and pending confirmations.** `chat_actions`, the three classes, the durable
   confirmation flow, and the `tasks` / `terminals` scopes on the concierge token. Fixed policy:
   the reversible class always asks.
3. **Vector memory and learning.** pgvector, the embedding container, `chat_memories`, the
   scoring, the "why it did not ask" line and the two escapes.
4. **Polish.** *Modo revisão*, per-conversation model, usage display, and the auto-versus-asked
   metric.
