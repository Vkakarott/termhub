---
symptom: "Answering a tab's question card does nothing: the tab keeps its dialog open and the card turns \"Respondida na aba\" with \"A pergunta mudou na aba\""
tags: [chat, tab-questions, screen-check]
evidence: fixed
card: TER-542
agent: claude
date: 2026-09-30
---
## Cause

Before typing an answer, `answerTabQuestion` checks that the card's question is the dialog the tab shows
now (`promptVisible` in `apps/server/src/chat/permission-dialog.ts`). For a choice it looked for the first
80 letters of the question in the last 25 non-blank lines. Claude Code draws a question card inside the
pane, and a card with long option descriptions can be taller than the pane: the start of the question is
above the top of the screen and is not in the capture at all (a full-screen TUI keeps no scrollback). The
check failed on a dialog that was right there, the server closed the card as `answered_in_tab` and
answered `409 TAB_PROMPT_CHANGED` without typing anything. The card read as answered, with a red
"A pergunta mudou na aba" under it, so nobody understood that nothing had been sent.

## Fix

- A choice is also recognised by its option labels: every label of the first question on screen, with the
  dialog footer on the last line.
- A dialog on screen that still does not match answers `409 TAB_PROMPT_NOT_SEEN` ("Não encontrei esta
  pergunta na tela da aba, então nada foi enviado. Responda direto na aba.") and leaves the card open. Only
  a tab with no dialog at all closes the card.
- The `TAB_PROMPT_CHANGED` text on the web and the phone now says nothing was sent.

## How to check

`npm test -w @termhub/server -- src/chat/tab-question-answer.test.ts`: the tests marked TER-542 use the
real capture in `fixtures/tab-questions/screen-choice-tall.txt`. When a card fails like this in
production, look for `tab question not recognised on screen` in the app log (ids only) and read the tab's
screen: a dialog whose first line is the tail of a question is this case.
