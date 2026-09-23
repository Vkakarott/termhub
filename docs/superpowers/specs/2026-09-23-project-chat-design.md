# A chat per project, beside the account-wide one

**Status:** proposed. Builds on `2026-09-20-chat-concierge-design.md` (gate, cards, conversation model) and `2026-09-22-user-hosted-concierge-design.md` (the CLI runs on the user's own host). Neither is superseded; this adds a second kind of conversation next to the one they describe.

## 1. The problem

The chat has one conversation per user, and nothing in the product can clear it. `cli_session_id` is only reset when the host machine or account changes (`db/repositories/chat.ts`, `setHost`) or when a `--resume` fails with `missing_session`. So every topic the person ever raised stays in the CLI's context.

In practice this breaks down as soon as the conversation spans projects. In the test that prompted this document, the person talked about three projects in one session. The model started mixing them up, and it answered short questions about one project with long status reports that also covered the other two.

Projects are now first-class in the sidebar (`2026-09-22-projects-decoupled-from-machines-design.md`). A conversation per project is therefore the natural unit, together with a way to start any conversation over.

## 2. Decisions

| Question | Decision |
|---|---|
| What happens to `/chat` | **It stays.** It is for questions that cross projects. Each project gets its own isolated conversation. |
| Host of a project chat | **The same host as the account-wide chat**: that conversation's `machine_id` and `ai_account_id`. There is no per-project host picker. The chat has no local tools (only the termhub MCP), so running on one of the project's machines would change nothing. |
| How tightly a project chat is bound | **Context only.** A system prompt names the project and says to focus on it. The MCP token keeps the same scopes and visibility as the account-wide chat, so the person can still ask about another project on purpose. |
| "Nova conversa" | **Archive and start clean.** The active conversation is marked archived and a new one takes its place, with a new CLI session. Old messages leave the screen but stay in the database. There is no history viewer in this version. |
| Where the project chat opens | **A right-hand drawer** over the current page. It survives navigation and is full-screen on mobile. |

## 3. Data model

`chat_conversations` gains two columns:

- `project_id` is a nullable FK to `projects`, `ON DELETE CASCADE`. `NULL` means the account-wide conversation. Deleting a project deletes its conversations, messages and actions, as `chat_messages` and `chat_actions` already cascade from the conversation.
- `archived_at` is a nullable timestamp. `NULL` means active.

The partial unique index `chat_conversations_one_per_user (user_id) WHERE tab_id IS NULL` is replaced by:

```sql
CREATE UNIQUE INDEX chat_conversations_one_active
  ON chat_conversations (user_id, COALESCE(project_id, ''))
  WHERE tab_id IS NULL AND archived_at IS NULL;
```

This allows one active conversation per user per scope, where the account-wide chat is one scope and each project is another, and any number of archived ones. As with the old index, Prisma cannot express it: it lives in the migration, and the model's doc comment is updated to say so.

**Host.** A project conversation leaves its own `machine_id` and `ai_account_id` null and never reads them. The host is always resolved from the user's account-wide conversation. That conversation is created on demand if it does not exist yet, using the existing `getOrCreateForUser`, which is renamed or narrowed to the `project_id IS NULL` scope. `setHost` still applies only to the account-wide conversation. When it moves the host and clears that conversation's `cli_session_id`, it also clears `cli_session_id` on every active project conversation of that user. Their CLI sessions live in the old host's config directory and cannot be resumed on the new one (user-hosted spec §3).

**Repository changes** (`db/repositories/chat.ts`):

- `getOrCreateForUser(userId)` keeps its name and callers (`resolveHost`, the account-wide chat) and is narrowed to the active account-wide row (`project_id IS NULL AND archived_at IS NULL`).
- `getOrCreateForProject(userId, projectId)` is the same create-then-reread-on-conflict lookup for a project's active row.
- `findByIdForUser(id, userId)` reads a conversation by id, owner-scoped: how a decision finds the conversation its action belongs to.
- `archive(conversationId)` sets `archived_at = now()`.
- `listActiveProjectConversations(userId)` returns, per project, whether its active conversation has a run in progress or a pending confirmation — what the sidebar indicator needs (§5.3).

## 4. Server

### 4.1 Routes (`routes/chat.ts`)

| Route | Change |
|---|---|
| `GET /api/chat?project=<id>` | Returns the active conversation for that project, creating it if absent, with the same payload as today. Without `project` it behaves exactly as today. `project` must be a project the caller owns: 404 otherwise, through the same owner check the projects routes use. |
| `POST /api/chat/messages` | Accepts an optional `project_id` alongside `text`. |
| `POST /api/chat/actions/:id/decision` | Unchanged: the action row already knows its conversation. |
| `POST /api/chat/host` | Unchanged, and only for the account-wide conversation. |
| `GET /api/chat/projects` *(new)* | `[{ project_id, busy, pending_confirmations }]` for the caller's active project conversations; feeds the sidebar indicator on load. |
| `POST /api/chat/reset` *(new)* | Takes `{ project_id?: string }`. It archives the active conversation of that scope and returns the new, empty one. Returns 409 `CHAT_BUSY` while a run holds that conversation's lock. Pending confirmations of the archived conversation are expired, so they are not injected into a session nobody is reading. |

### 4.2 `ChatService`

- `send`, `resumeAfterDecision` and `drainNextDecision` take a conversation, not a user. The busy lock is already keyed by conversation id, so a project chat and the account-wide chat, or two project chats, can run at the same time.
- **The token carries its conversation.** The gate (`chat/gate-runtime.ts`) finds the chat to ask in from the token alone, and today does it with "the user's one conversation" (its own comment: "per-machine conversations will have to carry the id on the token"). `api_tokens` gains a nullable `chat_conversation_id` (FK, `ON DELETE CASCADE`), set only on concierge tokens. The gate reads the conversation from the token. A gated token with no conversation (one minted before this change, alive for at most 24 h) falls back to the account-wide conversation, as today.
- **Token rotation becomes per conversation.** `mintConciergeToken` currently revokes *every* active concierge token of the user (`chat/token.ts`). With two conversations running at once, one run would revoke the other's token mid-answer. It now takes the conversation id, stores it on the token, and revokes only the previous tokens of that same conversation. Reset also revokes the archived conversation's tokens.
- **Concierge tokens stop counting against the personal-token cap.** `countActive` (checked against `MAX_ACTIVE_TOKENS_PER_USER = 20` when a person creates a token) excludes gated tokens. Otherwise a user with many project chats would be unable to create a token of their own.
- Host resolution (`chat/host.ts`) takes the conversation that owns the host (always the account-wide one) separately from the conversation being run.

### 4.3 The project system prompt

`packages/claude-cli` gains an optional `append_system_prompt` on `ClaudeRunSpec`. It is passed as `--append-system-prompt <text>` and omitted when absent, so the account-wide chat's command line is unchanged.

The server builds the text per run, so it reflects renames and machine links as they are now:

```
You are the termhub chat for the project "<name>" (key <KEY>).
Its machines and directories: <machine name> → <path>; …
Answer about this project. Do not report on other projects unless the person asks about them by name.
Keep answers short unless asked for detail.
```

Only names, keys and paths go in. There are no task contents, tab screens or output: the model reaches those through the MCP tools, as it does today.

**Agent compatibility.** The prompt reaches the host inside the agent's `open` params (`kind:'claude'`), as a new `append_system_prompt` field. An agent that does not know the field would silently drop it, so the agent advertises a new capability, `claude.system_prompt`. `resolveHost` returns `agent_too_old` for a *project* conversation when the host lacks it. The account-wide chat keeps requiring only `claude`.

### 4.4 Bus and WebSocket

Every `ChatEvent` in `chat/bus.ts` gains `conversation_id`. `/ws/chat` stays per user. Clients filter by `conversation_id`, so the drawer and the `/chat` page never render each other's deltas, cards or `reset` events.

## 5. Web

### 5.1 `ChatPanel`

The conversation body of `pages/ChatPage.tsx` becomes `components/chat/ChatPanel.tsx`, taking `projectId: string | null`. It contains the thread, action cards, composer, stream hook, scroll behaviour and the host-state messages (offline, agent too old). `useChatStream` (`lib/chat.tsx`) filters events by the panel's conversation id.

The panel gets a **Nova conversa** button in its header. It asks for confirmation ("O contexto atual desta conversa será descartado."), calls `POST /api/chat/reset` and swaps in the returned conversation. The button is disabled while an answer is being generated.

`ChatPage` becomes the `ChatLayout` shell, plus the host picker (`ChatHost`), plus `<ChatPanel projectId={null} />`. It behaves as before, plus Nova conversa.

In a project panel, the "no host chosen" state (`not_chosen` / `no_machine`) shows a sentence and a link to `/chat`, where the host is picked. The picker is not repeated in the drawer.

### 5.2 `ChatDrawer`

- `components/chat/ChatDrawer.tsx` is rendered once in `Layout`, outside the routes, so it **stays open while the person navigates**. It can sit over the project's tabs or kanban.
- A small context (`lib/project-chat.tsx`: `openProjectChat(id)`, `closeProjectChat()`, `openProjectId`) holds which project is open. Opening another project's chat swaps the drawer's content, and clicking the open project's 💬 again closes it.
- Desktop: fixed to the right edge, about 420px wide, **over** the content. It does not resize the main area, so xterm panes never re-fit because a chat opened.
- Mobile: full-screen, reusing `ChatLayout`'s viewport handling (`trackAppHeight`, the `chat-locked` body class) so the composer stays above the keyboard.
- Header: `Chat · <project name>`, Nova conversa, and ×.
- Escape closes the drawer through the same open-stack as `Modal` (`components/Modal.tsx`). A confirm dialog opened from the drawer closes first, and the drawer closes on the next Escape.
- **Closing is not stopping.** A run in progress finishes on the server, and reopening shows the answer. The CLI session lives until Nova conversa, or until a host change invalidates it (§3).

### 5.3 Sidebar

In the project row of `components/Sidebar.tsx`:

- **The ✕ (delete) goes away**, along with its `ConfirmDialog`, `deletingProject` and `deleteError`. Deleting a project stays in the ✎ settings page, which already has its "Excluir projeto" zone (`components/ProjectSettings.tsx`).
- **💬 "Chat do projeto"** takes its place, left of ✎, hover-only like the other row actions. It calls `openProjectChat(p.id)`.
- When that project's conversation is **answering** or has a **pending confirmation**, the 💬 stays visible without hover and shows a dot, so the person can see it is working or waiting on them. The state comes from the bus events already on `/ws/chat` and from `GET /api/chat/projects` on load (§4.1).

## 6. What this does not do

- No history viewer for archived conversations. The rows are kept so one can be added later.
- No per-project host or model.
- No tool-level restriction to the project. The binding is by prompt only, as decided.
- No change to the gate, the action classes or the MCP tools.

## 7. Testing

**Server**
- Repository:
  - one active conversation per scope under concurrent `getOrCreateForProject`
  - `archive` frees the scope
  - deleting a project cascades to its conversations
- Service:
  - two conversations of the same user run concurrently and neither run's MCP token is revoked by the other
  - the gate asks in the conversation named by the token
  - a host change clears `cli_session_id` on the project conversations
- Route `reset`:
  - 409 while busy
  - pending confirmations are expired
  - the archived token is revoked
  - 404 for a project the caller does not own
- System prompt: built from the project's current name and links, and passed only for project conversations. `buildClaudeArgs` emits `--append-system-prompt` only when set.
- Host: `agent_too_old` for a project conversation on an agent without `claude.system_prompt`.

**Agent**
- `run.ts` forwards `append_system_prompt` into the argv and advertises the capability.

**Web**
- Sidebar: the row has 💬 and ✎ and no ✕. 💬 opens the drawer for that project, and 💬 on the open project closes it.
- Drawer:
  - swaps content between projects
  - Escape order with a confirm dialog on top
  - stays open across route changes
- `ChatPanel`:
  - ignores events of another conversation
  - Nova conversa confirms, resets and is disabled while streaming
- The existing `ChatPage.test.tsx` and `ChatPage.stream.test.tsx` keep passing against the extracted panel.

## 8. Deploy notes

- The migration only adds nullable columns and swaps an index. It is compatible with the running server: the old code never creates a second active row, so the new index holds on existing data.
- Agents must be updated for project chats to run. Until they are, the drawer shows the existing "agent too old" message, and the account-wide chat keeps working.
- **Rolling back to the previous server needs care once any user has pressed "Nova conversa" or opened a project chat.** Both actions create a second (or third, …) `chat_conversations` row for that user. The old server's `getOrCreateForUser` (`findFirst({ userId })`, oldest first) has no notion of `project_id` or `archived_at` and would pick whichever row is oldest as "the" conversation — an archived one, or a project's — instead of the account-wide chat the person actually expects. Those rows must be dealt with before rolling back; this document does not prescribe how (no SQL here).
