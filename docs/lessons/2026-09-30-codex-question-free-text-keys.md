---
symptom: "Codex question answered as \"None of the above\" without the typed text (request_user_input notes lost)"
tags: [codex, tab-questions, keys]
evidence: fixed
card: TER-497
agent: claude
date: 2026-09-30
---
## Cause

Codex's `request_user_input` menu (codex-cli 0.159.2) is not Claude Code's AskUserQuestion dialog. A digit
answers the question at once and moves on, and on the last question it submits everything (there is no
review step). The digit of "None of the above" therefore submits that option with no notes: typing
afterwards lands in the next question or in the prompt. The notes row only opens with `Tab` while the
cursor sits on the option.

A second trap was in the hook script: the dedupe marker. A Codex `request_user_input` PreToolUse travels
whole and did not touch the marker, so in two questions in a row the second question's reduced
`PostToolUse` matched the first one's marker and was dropped.

## Fix

- Free text: `Down` × (number of options) to reach "None of the above", `Tab`, the text, `Enter`
  (`codexChoiceKeyPlan` in `apps/server/src/chat/tab-question-keys.ts`). An option is just its digit.
- Approval menu: `y` approves; `Escape` cancels and leaves Codex at its prompt, where text + `Enter` is
  the next instruction (`codexPermissionKeyPlan`).
- The hook script clears the marker on a Codex `request_user_input` PreToolUse
  (`packages/machine-ops/src/hooks.ts`).

## How to check

In a Codex tab in Plan mode, ask for two questions at once and answer the first with free text from the
chat card: Codex prints `answer: None of the above` with `note: <your text>`, then the second question.
Real screens: `apps/server/src/chat/fixtures/codex-questions/two-questions.txt` and
`apps/server/src/chat/fixtures/permission-dialogs/codex-reason.txt`.
