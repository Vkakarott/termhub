# Chat: standing grants per project ("sem prazo") for routine actions — design

Card: **TER-386** (epic TER-1 · Chat). Builds on spec 2026-09-25-chat-tab-grant-design.md (TER-2,
"Permitir sempre nesta aba"), 2026-09-26-chat-grants-list-design.md (TER-67 list, TER-94 batches),
2026-09-26-chat-project-grant-design.md (TER-111, "Permitir sempre neste projeto") and
2026-09-27-chat-terminal-grant-design.md (TER-325, "Liberar teclas e shell" / "Liberar tudo"). Memory:
2026-09-26-concierge-memory-mcp-design.md (TER-95). Project rule: what the chat does works in the mobile app
too, in the same delivery.

Every decision below was taken without the user (2026-09-28, asked to decide alone and only to ask on a
scope change); the reason is written next to each one.

## 1. Problem

Pedro (2026-09-28): "ainda estou precisando clicar no aprovar. isso perde muito tempo, pode ir direto nesses
casos". The routine cases are opening a terminal, closing a tab whose agent finished, starting an agent on a
card and creating or moving cards. Today's grants do not cover them: the tab and project grants live in one
conversation and die in 24 h, and `open_tab`, `close_tab` and `start_agent` have no grant at all — every
one is a card, in every conversation, every day.

He also told the concierge "o que terminou é fechar os agentes. Já era para estar na memória e está sendo
feito automaticamente"; the concierge wrote it down as a note (`note:w6r8bdlld3ur`, trust `derived`), and
the card asks the gate to honour decisions like that one.

What must not happen: the concierge reads terminal screens, card descriptions and attachments, any of which
can carry text written by somebody else. A standing permission must not let injected text start an agent
with an arbitrary prompt anywhere, close a tab that is working, or touch another project or another user's
things. Irreversible or external actions keep asking, always.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| What a standing grant is | A row in a new table `chat_standing_grants`: **one user + one project + one kind**, no expiry, until revoked. It is not tied to a conversation: it holds in the project chat, in the general chat and after "Nova conversa". | The card: "por projeto, sem prazo (até o Pedro revogar), por tipo de ação". Conversation-bound grants stay as they are (24 h, revoked by reset): the two models coexist, and the user picks the one he wants on the card. |
| Kinds | Five, closed in code (`STANDING_GRANT_KINDS`): `open_tab` (`open_tab`), `close_tab` (`close_tab`), `start_agent` (`start_agent`), `board` (`create_task`, `add_subtasks`, `update_task`, `move_task`), `terminal` (`send_input`, `send_key` on the project's tabs). | The card's list, one kind per line of it. `board` and `terminal` reuse the sets TER-111 and TER-325 already closed; a tool added later is not covered until someone decides it. |
| Always asked, under every grant | `delete_task`, `push_ticket_status`, `create_integration`, `set_project_repo`, `run_command`, `unlink_project_machine`, `link_project_machine`, `set_project_machine_cwd`, `sync_tickets`, `import_tickets` and every tool outside the five kinds; `send_input` with `answering_permission`; `send_key` while the tab is `waiting_permission` or a permission dialog is on screen; text starting with `!`; text with a control character other than a newline. | The card's exclusions plus the existing text rules (TER-2, TER-325). A standing grant widens *when* a routine action runs, never *which* actions are routine. |
| Which project a call belongs to | `open_tab` / `start_agent` → `args.project_id`, only if `projects.findByIdsForOwner` resolves it; `close_tab` and the terminal tools → the tab (`tabs.findByIdsForOwner`) and its `project_id`; board tools → `boardProjectOf` (TER-111). A call whose project does not resolve is **asked**, as today. | Same rule every grant follows: the grant is judged on the project the write lands in, resolved with the user's own id, so a foreign id is never probed through a grant. |
| `close_tab` guard | Covered only while the tab is **not** `working` and **not** `waiting_permission`. `waiting_input`, `idle`, `error` and a tab that never reported (a shell) are covered. | "Aba que terminou, fecha": an agent that finished sits at `waiting_input` (its prompt) or `idle` (session ended). A `working` tab is the one the card names as the risk. A never-reported shell has no signal either way; the trail shows every close, and the tab list is one click away. |
| `close_tab` and the token ownership check | `control/terminals.ts` skips its "opened by this token" check for a gated token because the gate asked. The gate keeps that promise: under a standing grant the tab is resolved owner-scoped **and** its `project_id` must be the granted project before the call runs; a tab of another project or another user is asked. The comment in `gate.ts` that forbade granting `close_tab` is rewritten to state this. | The comment's worry was "close any of the user's tabs without a question"; the project check plus the trail is what answers it. `close_tab` stays class `irreversible` on the audit row. |
| `start_agent` guard | Covered when its project resolves. `task_id` of another project is already refused by the tool. The prompt is kept in the audit row and its summary is the card in the trail. | The card accepts the residual risk (an injected prompt) against project scope, budget and audit. The agent runs under Claude Code's own permission model on the machine. |
| Rate budget | Per grant, rolling hour (`STANDING_GRANT_BUDGETS`): `open_tab` 30, `close_tab` 30, `start_agent` 10, `board` 30, `terminal` 120. Counted across conversations (`countByGrantSince(grantId, since)`, on a new `chat_actions (grant_id, created_at)` index). The call past the budget is asked like any other. | A brake, not a quota: an injection that tries to flood cannot do a whole board or a machine's worth of agents before a card appears. The numbers follow the existing ones; `start_agent` is lower because each one is a session on the user's account. |
| Precedence | Unchanged first: an open row for the same call or a denial in force decides. Among grants: narrow tab grant, then tab "teclas e shell", then project (board / "tudo"), then **standing**. | A "no" beats a grant. The conversation grants come first so their budgets are spent before a standing one — and so the existing tests stay exactly as they are. |
| Where it is granted | One more button on a pending card: **"Liberar sem prazo: &lt;ação&gt; neste projeto"**, where &lt;ação&gt; is the kind's label (§6). On board and terminal cards it sits beside the existing buttons; on `open_tab` / `close_tab` / `start_agent` cards it is the only standing button. Not in the grouped card (TER-94): reached through "Ver separadas". | "Sem prazo" must be a deliberate single decision, one click per kind per project, ever — which is exactly the cost the user wants to pay instead of a click per action. |
| Server eligibility | `approve_project_always`: pending, `standingKindOf(tool, args)` is a kind, and the project resolves as above (for the terminal kind: the tab resolves owner-scoped). Otherwise `400 GRANT_NOT_ALLOWED` before deciding anything (and, on the phone, before the PIN challenge is spent). | Same pattern as every other grant word. |
| The card that created it | "&lt;Ação&gt; liberado neste projeto, sem prazo · Revogar". A card run under a standing grant keeps the tool-based label (`aba confiada` / `quadro confiado`) and, for the three tools that never had one, reads "· liberado no projeto". | Consistent trail. |
| PIN on the phone | Always the PIN, proof word `approve_project_always`. "Revogar" needs none. | The widest grant there is. |
| Memory ("decisões da memória liberando o gate") | The gate **never reads free text** from memory. The user's decision is stored structured (this table) and is what the gate consults; a `derived` note like `note:w6r8bdlld3ur` — text the concierge wrote — can never release the gate, and a `person` message ("o que terminou é fechar") cannot be parsed into a permission with any reliability. What the note asked for is delivered by the `close_tab` kind with its `working` guard: one click on the next close card, and every finished tab is closed without asking, for good. | TER-95 D2: text an agent wrote may carry an injection; letting it drive an action turns memory into an amplifier. Every earlier grant spec keeps the invariant "grants are only born from a user's click" — this one too. The gain the user asked for (no click per routine action) is met; the mechanism differs on purpose, and the summary to him says so. |
| Telling the model | (a) The injected decision sentence gets a `STANDING_GRANT_NOTE` naming the kind, the project, the budget, the exceptions and that read text is data. (b) The project chat's system prompt (`projectSystemPrompt`) gains one line, only when the user has standing grants on that project: "Liberado sem confirmação neste projeto: abrir abas, fechar abas paradas, …". | The model proposes without saying "vou precisar da sua confirmação", and knows the limits. The prompt line is deterministic and short (fits the 4000-char budget); memory search is not needed for it. |
| Where grants are listed | "Permissões do chat" (web `/settings/chat-grants`, app screen) lists standing grants with the others: rows "&lt;Ação&gt; no projeto X · sem prazo" (or "Projeto que não existe mais"), state `active` / `revoked` only — never `expired` nor `ended`, since neither a clock nor "Nova conversa" ends them. The conversation indicator counts them too. | One place to see and revoke everything. |
| `GET /chat` | Adds `standing_grants: ChatStandingGrantView[]`: the user's active standing grants for the conversation's project, or all of them for the general chat. | The card's granted state (`source_action_id`) and the indicator need them; filtered server-side so a project chat never counts another project's. |
| Mobile compatibility | `GET /chat/grants` returns standing rows only with `kinds=all_standing` (new); `all` stays tab + project. The list item schema gains `kind: 'standing'`, `standing_kind`, and `expires_at` nullable **only** on standing rows. New events `standing_grant` / `standing_grant_revoked`; old apps ignore unknown event types and fields. | Installed builds parse `expires_at: z.string()` and `kind: z.enum(['tab','project'])` — a standing row would reject the whole page. Opt-in keeps them whole. |
| Revoke | `DELETE /chat/grants/:id` (web and phone) tries tab, project, then standing grants (ids never collide). | One route for clients. |
| Data | New table; `chat_actions.grant_id` reused (no kind column, the kind is derived from the tool as today); one new index. | The previous release never reads the new table or the index; `grant_id` rows of a standing grant show in the old release as "aba confiada"/"quadro confiado" — cosmetic, only while it serves. |

## 3. Data model

Migration `20260928230000_chat_standing_grants`:

```sql
CREATE TABLE "chat_standing_grants" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "conversation_id" TEXT,
  "source_action_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "revoked_by" TEXT,
  CONSTRAINT "chat_standing_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_standing_grants_user_id_project_id_idx" ON "chat_standing_grants"("user_id", "project_id");
CREATE UNIQUE INDEX "chat_standing_grants_one_active" ON "chat_standing_grants"("user_id", "project_id", "kind") WHERE "revoked_at" IS NULL;
ALTER TABLE ... user_id → users ON DELETE CASCADE; project_id → projects ON DELETE CASCADE;
                conversation_id → chat_conversations ON DELETE SET NULL;
CREATE INDEX "chat_actions_grant_id_created_at_idx" ON "chat_actions"("grant_id", "created_at");
```

- `project_id` is a real FK (unlike the conversation grants): a deleted project ends its standing grants,
  which is what "no expiry" needs. `conversation_id` (the chat that granted it) is only for the list's
  origin label and the event; `SET NULL` so a deleted conversation never deletes the grant.
- `ChatStandingGrant`: `{ id, user_id, project_id, kind: StandingGrantKind, conversation_id, source_action_id,
  created_at, revoked_at, revoked_by }` (an unknown `kind` value maps to `null` and is never active —
  defensive, like `scope`).
- `ChatStandingGrantsRepository` (`db/repositories/chat-standing-grants.ts`):
  `grant({ user_id, project_id, kind, conversation_id, source_action_id })` (revokes the previous active row of
  the triple in the same transaction), `findActive(userId, projectId, kind)`, `listActive(userId, projectId?)`,
  `findActiveBySourceAction(userId, actionId)`, `findByIdForUser(id, userId)`, `revoke(id, userId)`,
  `listForUser(userId, { state: 'active' | 'ended', cursor, limit })` (with the conversation's `project_id` /
  `archived_at`, same cursor rules as the others).
- `ChatActionsRepository.countByGrantSince(grantId, since)`.

## 4. Gate

`gate.ts` (pure):

- `STANDING_GRANT_KINDS = ['open_tab', 'close_tab', 'start_agent', 'board', 'terminal'] as const`.
- `standingKindOf(tool, args): StandingGrantKind | null` — `open_tab` / `close_tab` / `start_agent` by tool
  (`close_tab` needs a `tab_id` id; `open_tab`/`start_agent` a `project_id` id); `BOARD_GRANT_TOOLS` → `board`;
  `terminalGrantable(tool, args)` → `terminal`; else null.
- `STANDING_GRANT_BUDGETS: Record<StandingGrantKind, number>` (calls per rolling hour, §2).
- The `close_tab` comment above `irreversibleTools` is rewritten (§2).

`chat/standing-project.ts`: `standingProjectOf(repos, ownerId, kind, args): Promise<{ projectId: string; tab?: Tab } | null>`
— shared by the gate and the decision routes, so the button is accepted for exactly the calls the gate honours.

`gate-runtime.ts`, after the three existing grant checks and before `ask`, only with no row:

```
kind = standingKindOf(tool, args); none, or textOutsideGrant(args) for terminal    → ask
target = standingProjectOf(...); none                                             → ask
kind close_tab && tab.state in (working, waiting_permission)                      → ask
kind terminal && tab.state === waiting_permission                                  → ask
grant = chatStandingGrants.findActive(user, project, kind); none                   → ask
countByGrantSince(grant.id, now - 1h) >= budget[kind]                              → ask
kind terminal && permissionOnScreen(tab)                                           → ask
                                                                                    → executeGranted(grant.id)
```

`executeGranted` / `execute` / `staleApproval` are reused unchanged: a `close_tab` or terminal row whose tab
turned `waiting_permission` between the gate and the call fails `WAITING_PERMISSION` (the granted-row
message is reworded to "antes desta ação" so it reads right for a close as well as a key); a gone tab is
`TAB_GONE`. The trail is told live with `granted_action`.

## 5. API and events

- `chat/grants.ts`: `assertStandingGrantableAction(repos, userId, actionId)` → `{ action, kind, projectId }`
  (400 `GRANT_NOT_ALLOWED` / 404 / 409); `grantStanding(repos, userId, action, kind, projectId)` → creates,
  describes, publishes `standing_grant`; `activeStandingGrants(repos, userId, projectId | null)`; `revokeGrant`
  tries the third repository and publishes `standing_grant_revoked`; `listGrants` merges the third table for
  `kinds=all_standing`.
- Web `POST /api/chat/actions/:id/decision`: `decision` gains `'approve_project_always'`; checked before
  deciding; after the approval a failed grant only logs; the answer carries `standing_grant`.
- Mobile `POST /api/m/v1/chat/actions/:id/decision`: `{ decision: 'approve_project_always', challenge, pin_proof }`,
  eligibility before the challenge, proof over the word. Batches stay `approve` / `deny`.
- `GET /chat` (web and mobile): `standing_grants`.
- `GET /chat/grants`: `kinds: 'tab' | 'all' | 'all_standing'`.
- Events (`bus.ts`, `packages/mobile-api` `chatEventSchema`, parity samples): `standing_grant { grant }`,
  `standing_grant_revoked { grant_id }`, both with `user_id` and `conversation_id` = the granting
  conversation's id. A grant whose conversation is gone (`conversation_id` null) publishes no revoke event:
  the list screen re-reads on its own (TER-67 §2) and an open conversation drops the row on its next
  `GET /chat`. Clients apply `standing_grant_revoked` by id whatever the conversation, since a standing
  grant is not conversation-bound.
- `ChatStandingGrantView`: `{ id, project_id, project_name, kind, source_action_id, created_at }`.
- `ChatGrantListItem` gains `kind: 'standing'`, `standing_kind: StandingGrantKind | null`, `expires_at: string | null`.
- Injected `STANDING_GRANT_NOTE(kind, projectName)` appended once per run that created one (§2).
- `projectSystemPrompt(project, links, standing: StandingGrantKind[])`: one extra line when non-empty.

## 6. Web — pt-BR copy

Kind labels (`STANDING_KIND_LABEL`, shared text in `grant-list-text.ts`): `open_tab` → "abrir abas",
`close_tab` → "fechar abas paradas", `start_agent` → "iniciar agentes", `board` → "mexer no quadro",
`terminal` → "teclas e texto nas abas".

- `ChatActionCard`, pending and `standingKindOf(action)` (client mirror in `packages/mobile-api`, the server
  is the judge): button "Liberar sem prazo: &lt;label&gt; neste projeto".
- A card that created an active standing grant: "&lt;Label, capitalised&gt; liberado neste projeto, sem prazo · Revogar".
- A card run under a grant whose tool is `open_tab` / `close_tab` / `start_agent`: "Executado · liberado no projeto".
- `ChatPanel`: `standingGrants` from `GET /chat`, live through the two events and the decision answer; the
  indicator counts them.
- "Permissões do chat": rows of kind `standing` read "&lt;Label&gt; no projeto X · sem prazo"; state label
  `active` / `revoked`; `api.listChatGrants` sends `kinds=all_standing`; intro line becomes "O que o chat pode
  fazer sem pedir confirmação. Permissões de conversa valem por até 24 horas; as sem prazo valem até você revogar."

## 7. Mobile app — pt-BR copy

- Action card: the same button → PIN sheet titled with the button label, proof over `approve_project_always`.
- Granted-card line, executed label and list rows as on the web (the app's lower-case style where it applies).
- Store: `ChatDecision` gains the word; `standingGrants` in the conversation slot; reducer for the two events;
  the indicator counts them. "Nova conversa" does **not** clear them.
- Mock server: the decision, `GET /chat`, `GET /chat/grants?kinds=all_standing`, `DELETE /chat/grants/:id`, events.

## 8. Risks — prompt injection

| Vector | What a standing grant allows | Mitigation |
|---|---|---|
| Screen / card / attachment text tells the concierge to start an agent with a hostile prompt | `start_agent` in the trusted project, on its linked machines | Explicit, separately labelled button; project scope; 10/h; every start in the trail with its prompt summary; one click to revoke; the injected note and the prompt line say read text is data; Claude Code's own permissions on the machine. Residual risk accepted by the card. |
| Same, to close a working tab | Nothing | `working` and `waiting_permission` tabs are asked; the execute-time lock catches a race into a dialog. |
| Same, aimed at another project or another user | Nothing | Project resolved owner-scoped from the arguments; tab's `project_id` must match; unresolved asks. |
| Same, to type a shell command | Typing into the project's tabs (terminal kind only) | TER-325's rules unchanged: `!`, control characters, permission dialogs, 120/h. |
| Same, to delete, push, publish, change integrations | Nothing | Outside every kind; always a card. |
| The model grants itself | Nothing | Grants are only born from a user's click (web session or phone PIN); memory text never releases the gate. |
| Budget overshoot | A few extra calls | Count and insert are not atomic (like the other budgets); a brake, not a quota. |

## 9. Tests

- `gate.test.ts`: `standingKindOf` truth table.
- `chat-standing-grants.db.test.ts` (Postgres, `TERMHUB_DB_TESTS=1`): grant / re-grant replaces / `findActive`
  filters (user, project, kind, revoked) / revoke scoped / `listForUser` states and paging / cascade on project
  delete; `chat-actions.db.test.ts`: `countByGrantSince`.
- `standing-project.test.ts`: each kind, own vs foreign vs missing target.
- Gate runtime (`gate-runtime.standing.test.ts`, in-memory fakes): each kind runs at once with `grant_id`;
  `close_tab` on a `working` / `waiting_permission` tab asks, on `waiting_input` / `idle` / null runs; a tab of
  another project asks; `start_agent` / `open_tab` on an unresolved project asks; terminal kind follows the
  TER-325 rules (`!`, control chars, dialog on screen, `waiting_permission`); the budget's (n+1)th call asks;
  `delete_task`, `run_command`, `push_ticket_status` still ask with every kind granted; a conversation grant
  is used before a standing one; a denial in force refuses; revoked asks; a granted `close_tab` whose tab turned
  `waiting_permission` fails `WAITING_PERMISSION`.
- Routes (`chat.test.ts`, `m-chat.test.ts`): the word decides + grants; ineligible → 400 before anything (and
  before the challenge on the phone); proof word required; `GET /chat` returns `standing_grants` (filtered by
  the conversation's project); `GET /chat/grants?kinds=all_standing` merges and pages, `all` does not include
  them; `DELETE` revokes a standing grant; reset leaves them.
- Service: `STANDING_GRANT_NOTE` appended once; `projectSystemPrompt` line only when non-empty.
- `packages/mobile-api`: body, proof word, list item with `kind: 'standing'`, events + parity samples.
- Web: card button per kind, granted state, executed label, indicator count, list rows, `kinds=all_standing`.
- App: store decide via PIN, reducer events, card, list screen, mock handler.
- Before finishing: server typecheck + web and landing builds through Docker (node:22) and each workspace's
  tests.

## 10. Out of scope

- Free-text or semantic memory as a gate input (§2, Memory).
- Granting from the list, a duration picker, per-kind budgets configurable from the UI.
- Covering `run_command`, `delete_task`, ticket pushes, integrations or permission answers under any grant.
- A standing grant for the general (project-less) chat's actions: every kind here resolves to a project.

## 11. Adjustments found while implementing

- `standingProjectOf` takes the `tool` too — `standingProjectOf(repos, ownerId, kind, tool, args)` — since the
  `board` kind needs `boardProjectOf(tool, args)` and the terminal kind needs to know which tool it judges.
- `conversation_id` is nullable on standing list items: the granting conversation may be deleted (FK
  `ON DELETE SET NULL`) while the grant lives on. Such a row's origin reads **"Conversa apagada"** on the web
  and in the app (`grantOriginLabel`), instead of "Chat geral".
- The web panel applies a live `standing_grant` event by project (every one of them in the general chat), not
  by conversation: a standing grant is not tied to the chat that granted it, so every open chat of the project
  shows it at once.
- The terminal note's wording is "send_key e send_input nas abas desse projeto" (the project is already
  named earlier in the sentence).
- The app's `features/chat-grants/model/labels.ts` re-exports the contract's `STANDING_KIND_LABEL` instead of
  copying the table (the web keeps its own copy, since it has no workspace deps). The app's PIN sheet titles a
  standing grant with the card's button label ("Liberar sem prazo: <ação> neste projeto"), passed as an
  optional `title` on `requestPinProof`.
- The system prompt line names its exceptions per kind: "delete_task, run_command, responder permissões,
  texto com "!" ou caracteres de controle" always, plus ", fechar abas trabalhando" only when `close_tab` is
  among the kinds.
- Residual `close_tab` window: the tab's state is checked at the gate; a tab that turns `working` between the
  gate and the execute is not re-checked (only `waiting_permission` is, and fails `WAITING_PERMISSION`). A
  shell that never reported a state is covered, as §2 decided.
- The active list is capped at 100 rows across its three sources (tab, project, standing grants); paging the
  active list is deferred.
- Migration renamed to `20260928233000_chat_standing_grants`: `main` added `20260928230000_api_token_tab`
  with the same timestamp prefix, and ours must apply after it.
