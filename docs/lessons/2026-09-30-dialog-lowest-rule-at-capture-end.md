---
symptom: "dialogTool reads a transcript title when the capture ends at its lowest box rule"
tags: [chat, permissions, terminal, capture]
evidence: fixed
card: TER-179
agent: chatgpt
date: 2026-09-30
---
## Cause

Scanning from the penultimate non-blank line assumes every rule has a line below it. When the last
line is itself a rule, that skips the lowest rule and can identify an older transcript title.

## Fix

Scan from the final non-blank line. Stop at the first rule even without a following line, returning
null for the missing title. Never resume scanning above an unknown or absent title.

## How to check

Run `npm test -w @termhub/server -- src/chat/permission-dialog.test.ts` with the server's
`DATABASE_URL` set. The case "lowest rule with no following line" must return null for a capture
containing an earlier `Edit file` title and a final rule.
