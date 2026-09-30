# TER-497 — Codex questions and approvals as chat cards; concierge stops monitoring loops

Card: TER-497 (epic TER-407). Builds on TER-356 (PR #234, Codex hooks). No separate spec: the design was
agreed in chat on 2026-09-30 (bounded change). This plan is the authority.

## Problem

Codex tabs report `working` / `waiting_input` / `waiting_permission` through hooks since TER-356, but a Codex
approval or question never becomes a card in the project chat, so the concierge opens subagents that sit
watching the Codex window. Claude Code's questions and approvals already become cards answered straight in the
tab (`chat/tab-questions.ts`, `chat/tab-question-answer.ts`).

## What was verified on hulk (codex-cli 0.159.2, `--no-alt-screen` and alt screen alike)

- **Approval menu** (fixture `apps/server/src/chat/fixtures/permission-dialogs/codex-reason.txt`):
  ```
    Would you like to run the following command?
    Environment: local
    Reason: <tool_input.description — the question written for the person>
    $ printf 'oi' > hello.txt
  › 1. Yes, proceed (y)
    2. Yes, and don't ask again for commands that start with `…` (p)
    3. No, and tell Codex what to do differently (esc)
    Press enter to confirm or esc to cancel
  ```
  `y` approves (the command runs). `Escape` cancels ("You canceled the request…", "Conversation interrupted")
  and leaves Codex at its prompt: text typed then + `Enter` is the person's next instruction.
- **Question tool** `request_user_input` (Codex's AskUserQuestion; shown in Plan mode). Arguments, from the
  session rollout:
  `{"questions":[{"header":"Nome","id":"nome_arquivo","question":"O arquivo deve ser azul.txt ou verde.txt?","options":[{"label":"azul.txt","description":"Usar o nome azul.txt."},{"label":"verde.txt","description":"Usar o nome verde.txt."}]}]}`
  Screen (fixture `apps/server/src/chat/fixtures/codex-questions/two-questions.txt`):
  ```
    Question 1/2 (2 unanswered)
    Qual cor: azul ou verde?
    › 1. Azul               Escolher a cor azul.
      2. Verde              Escolher a cor verde.
      3. None of the above  Optionally, add details in notes (tab)
    tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt
  ```
  (on the last question the footer says `enter to submit all`). Keys, verified:
  - an option: its digit — answers the question and moves on; on the last question it submits everything
    (no review step, unlike Claude Code);
  - free text: `Down` × (number of options) to reach "None of the above", `Tab` (opens the notes row), the
    text literally, `Enter` (moves on / submits all on the last question). A bare digit of "None of the
    above" does NOT open the notes.
  - no multi-select exists.
- **Hooks:** a hook runs when the question appears (the `PreToolUse` of `request_user_input`) and another
  right after it is answered (`PostToolUse`), then `Stop`. Today the hook script reduces every Codex
  `PreToolUse` to the tool name, so the server never gets the options.
- hulk runs `approvals_reviewer = "auto_review"`: a real approval there is auto-reviewed in ~3 s. A manual
  test uses `-c approvals_reviewer=user`.

## Global constraints

- Payload contract (optional fields, absent = Claude Code, so stored rows and old clients keep working):
  - `ChoicePayload.agent?: 'codex'`
  - `PermissionPayload.agent?: 'codex'` and `PermissionPayload.question?: string` (Codex's
    `tool_input.description`, trimmed, capped at `QUESTION_MAX`; omitted when blank). Never the command.
  - `SuggestionPayload.agent?: 'codex'`
- Nothing of `tool_input` besides the question text / options is ever stored, logged or put in meta.
  Logs carry ids, kinds and counts only (CLAUDE.md: terminal content is never logged).
- UI copy in pt-BR; code, comments and identifiers in English. Match the surrounding comment density.
- Every request input validated with zod; answers still go through `runKeyPlan` → `sendKey`/`sendInput`.
- Tests: `npm test -w @termhub/server -- <files>`, `npm test -w @termhub/web -- <files>`,
  `npm test -w @termhub/machine-ops -- <files>`, `npm test -w @termhub/mobile -- <files>`; typecheck with
  `npm run typecheck -w <pkg>`. Do NOT run `npm test -w @termhub/agent` (other sessions on this Mac depend on
  the live agent). Server tests that need Postgres may be skipped when no DB is reachable; unit tests must pass.
- Never touch `~/.codex`, `~/.termhub` or the running termhub-agent.
- Do not bump `apps/agent` version in these tasks (the controller does it after rebasing on main).

## Task 1: Codex events open cards (server interpretation)

Files: `apps/server/src/chat/tab-question-payload.ts`, `apps/server/src/monitor/state.ts`,
`apps/server/src/chat/tab-questions.ts`, their tests (`state.test.ts`, `tab-question-payload` tests,
`tab-questions` tests).

1. Payload types per the Global constraints; `choicePayload` (the stored-shape zod) accepts `agent: z.literal('codex').optional()`.
2. `parseCodexUserInput(toolInput: unknown): ChoicePayload | null` next to `parseAskUserQuestion`: accepts
   `{questions: [{question, header?, id?, options: [{label, description?}] (2–4)}] (1–4)}` with the same caps
   (QUESTION_MAX, HEADER_MAX, LABEL_MAX, DESCRIPTION_MAX); unknown keys ignored; `multi_select: false`;
   labels through `normaliseLabel`; missing description/header → `''`; returns `{ questions, agent: 'codex' }`;
   anything off-shape (including a question without options) → null.
3. `interpretCodexHook`:
   - `PreToolUse` with `tool_name === 'request_user_input'` and a payload that parses →
     `{ kind: 'waiting_input', text: cap(first question text), meta: { event, tool }, question: { kind: 'choice', payload, tool_use_id: toolUseIdOf(ev.tool_use_id) } }`
     (no `activity`). Unparseable → today's `working` result.
   - `PermissionRequest` → today's result plus, when the tool name is valid,
     `question: { kind: 'permission', payload: { tool_name, agent: 'codex', question? }, tool_use_id: null }`.
     Update the comment that says no card opens. Keep `text` as today.
   - Subagent events keep going through `asSubagent` unchanged.
4. `closesOpenQuestion`: Codex's `notify` (`meta.event === 'agent-turn-complete'`) never closes an open card —
   it only repeats the end of the turn its `Stop` already reported (and would close the reply card of Task 4
   right after it opens). Everything else unchanged.
5. Tests: the rollout payload above → choice card (agent codex, two options, header kept); an options-less
   question → no card; PermissionRequest with description → permission card with `question` and no command
   anywhere in the result; without description → card without `question`; invalid tool name → no card;
   subagent flag preserved; `closesOpenQuestion` false for `agent-turn-complete`, still true for Codex
   `PostToolUse`/`Interrupt`/`Stop`.

## Task 2: answering a Codex card in the tab

Files: `apps/server/src/chat/tab-question-keys.ts`, `apps/server/src/chat/permission-dialog.ts`,
`apps/server/src/chat/tab-question-answer.ts`, and every other caller of `choiceKeyPlan` /
`permissionKeyPlan` / `promptVisible` (grep: auto-answer, gate, MCP `answer_tab_question`); their tests.

1. `codexChoiceKeyPlan(payload, answer)`: per question, a selected option → its digit; a text answer →
   `Down` × options.length, `Tab`, `{ text }`, `Enter`. No final submit key. `codexPermissionKeyPlan(answer)`:
   allow → `[{ key: 'y' }]`; deny → `[{ key: 'Escape' }]`; deny with text → `Escape`, `{ text }`, `Enter`.
   Export one dispatcher used by `answerTabQuestion` (and the other callers) that picks by `payload.agent`.
   Confirm `'y'`, `'Down'`, `'Tab'` are in `TMUX_KEYS`.
2. `promptVisible` for `payload.agent === 'codex'`:
   - permission: the last non-blank line contains `Press enter to confirm or esc to cancel`
     (compare case-insensitively), and the block (`PROMPT_MARKER_LINES`) contains, squashed and lower-cased,
     `would you like to` or `do you want to`;
   - choice: the last non-blank line contains `enter to submit` (case-insensitive) and the block contains the
     squashed first question (first 80 chars), as for Claude.
   Claude's rule is unchanged.
3. Tests with the real fixtures `codex-reason.txt` and `codex-questions/two-questions.txt` (true), the same
   screens with the menu gone (e.g. `codex-typed-numbered-prompt.txt`, or the fixture with its last lines
   replaced by Codex's idle composer) (false), a Claude dialog screen for a Codex row (false), key plans for
   every branch, and one `answerTabQuestion` test per Codex kind asserting the exact keys sent.

## Task 3: hook script forwards Codex's question

Files: `packages/machine-ops/src/hooks.ts` (HOOK_SCRIPT), `packages/machine-ops/src/hook-script.test.ts`.

- A Codex `PreToolUse` whose tool is `request_user_input` travels whole, like Claude's `AskUserQuestion`
  (same second-`"tool_name"` guard, marker neither read nor written). Past 200000 characters the reduced body
  goes instead (as for Codex's PermissionRequest). Claude's `request_user_input`, and any other Codex tool,
  stay reduced. Update the comment that says "Codex has no such tool".
- Tests in the existing hermetic style: the Codex question is forwarded whole; the oversize case is reduced;
  Claude with that tool name is reduced; the following Codex `PostToolUse request_user_input` is still sent.

## Task 4: a Codex question in prose becomes a reply card

Files: `apps/server/src/monitor/ingest.ts`, `apps/server/src/chat/tab-suggestions.ts`,
`apps/server/src/chat/tab-suggestion-send.ts`, their tests.

- After `noteHookEvent`, for `tool === 'codex'`, `meta.event === 'Stop'`, not a subagent: `openCodexReply`
  opens a `suggestion` row with payload `{ text: '', context: cleanContext(text), agent: 'codex' }` only when
  the context's last paragraph (after trimming) ends with `?` or `？`. Same repository call and publishing
  as Claude's suggestion (`tab_suggestion` event). Never throws; logs ids only.
- `sendTabSuggestion` for a Codex row: the body text must be non-blank; the live check replaces the
  dimmed-suggestion comparison: the tab (through the scope) is still `waiting_input` and its `state_at` is not
  later than the row's `created_at`, and the plain screen shows no dialog (`permissionDialogVisible` false and
  no `enter to submit` question footer). On failure: close the row and 409 as today. Keys: the text literally,
  then `Enter` (same send helpers as the Claude path). Dismiss is unchanged.
- Tests: Stop ending in a question opens the card; a Stop that does not end in `?`, a subagent Stop, and a
  Claude Stop do not; the following `notify` does not close it (Task 1 rule); send happy path keys; send after
  the tab moved on (state changed) → 409 and closed; empty text → 400.

## Task 5: the web and mobile cards say it is Codex

Files: `apps/web/src/lib/types.ts`, `apps/web/src/components/chat/TabQuestionCard.tsx`,
`apps/web/src/components/chat/TabSuggestionCard.tsx`, `apps/web/src/components/chat/tab-suggestion-text.ts`,
`tab-question-text.ts` if the titles live there, their tests; the mobile copies under
`apps/mobile/src/features/chat/` (model text helpers + the components that render the cards).

- Types gain the optional fields.
- Permission card, `agent === 'codex'`: title `O Codex pede permissão` and, when present, `payload.question`
  shown as the question (plain text, pre-wrap); tool name stays as secondary text. Buttons unchanged.
- Choice card, `agent === 'codex'`: same card; where the title names Claude Code, say `o Codex`.
- Suggestion card, `agent === 'codex'`: open title `«<tab>» terminou — o Codex perguntou:` (without tab name:
  `Uma aba terminou — o Codex perguntou:`), hint `Responda aqui ou na aba.`, empty input with placeholder
  `Sua resposta`, `Enviar` disabled while blank; closed title unchanged.
- Tests for each branch; the Claude rendering is unchanged.

## Task 6: the concierge stops opening monitoring subagents

Files: `apps/server/src/chat/concierge-prompt.ts`, `apps/server/src/chat/project-prompt.ts`,
`apps/server/src/mcp/tools.ts` (`start_agent`, `wait_for_state` descriptions), `apps/server/src/control/agents.ts`
(`startAgent` note), their tests (`concierge-prompt.test.ts`, `project-prompt.test.ts`, tools / agents tests
that assert the texts).

- ORCHESTRATOR_PROMPT: drop "waiting on an agent" from the delegate list and add a rule: tabs running Claude
  Code, Codex or Cursor report their state through hooks; their questions and approvals reach the person as
  cards in this chat and the monitor tells you when a tab stops. Never launch a subagent to watch or poll a tab
  in a loop. To follow a tab, call wait_for_state (again after a timeout, a few times at most) and then
  read_last_answer for its answer; otherwise end your turn and rely on the monitor's notices.
- project-prompt: the cards sentence covers Codex too ("Claude Code or Codex").
- `start_agent` description and `startAgent` note: follow with wait_for_state and read_last_answer (read_screen
  only for what is on screen); questions and approvals come as cards; no monitoring loop.
- `wait_for_state` description: add that it is the way to follow a tab, instead of a subagent polling it.
- Tests assert the new rule's key phrases (`wait_for_state`, `read_last_answer`, never a subagent to watch a
  tab) and the absence of "waiting on an agent".

## Task 7: the Codex reply card is opt-in per user (decided 2026-09-30)

Pedro's decision under the new CLAUDE.md "Impact on other users" rule: approval and `request_user_input` cards
stay on for everyone (parity with Claude Code's cards, and only with trusted Codex hooks); the prose reply card
of Task 4 is a per-user setting, **off by default**.

Files: follow the existing `chat_autodecide` switch end to end — `apps/server/prisma/schema.prisma` (+ a new
migration, backward compatible: `ADD COLUMN ... NOT NULL DEFAULT false`), `apps/server/src/db/repositories/users.ts`,
the settings route that reads/writes `chat_autodecide` (`apps/server/src/routes/chat-memory.ts` and its
control module), the web Settings UI that shows that switch, the mobile app if it shows that switch, and
`apps/server/src/chat/tab-suggestions.ts` (`openCodexReply`).

- New `User.chatCodexReplies Boolean @default(false) @map("chat_codex_replies")`.
- Read/write it wherever `chat_autodecide` is read/written (same zod validation, same response shape, field
  `codex_replies` next to it — match the existing naming).
- `openCodexReply` opens the card only when the owner of the project (the user whose conversation receives the
  card) has it on; otherwise it does nothing (log nothing but ids).
- Web Settings, next to the other chat switches: label `Responder perguntas do Codex pelo chat`, help
  `Quando o Codex termina o turno com uma pergunta, abre um card no chat para você responder sem ir até a aba.`
- Tests: default false; the switch round-trips through the route; `openCodexReply` opens only when on; the
  settings UI renders and toggles it. Regenerate the Prisma client (`npx prisma generate` in apps/server) as the
  project does.
