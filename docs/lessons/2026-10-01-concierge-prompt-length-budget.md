---
symptom: "concierge-prompt.test.ts: expected streamedSystemPrompt('x'.repeat(4000)).length to be less than or equal to 8000"
tags: [concierge, prompt, chat, tests]
evidence: fixed
card: TER-641
agent: claude
date: 2026-10-01
---
## Cause

`ORCHESTRATOR_PROMPT` (`apps/server/src/chat/concierge-prompt.ts`) goes first in every streamed system
prompt, followed by the project prompt (up to 4000 chars), and the whole thing must fit the 8000-char
protocol cap. So the concierge prompt itself has a budget of about 3998 chars. On 2026-10-01 it was
3856 chars, leaving about 140. A sentence of about 185 chars added to one rule went over the budget and
failed the test, even though nothing else changed.

## Fix

Keep additions to the concierge prompt short, and move the detail into the tool's own `description`
in `apps/server/src/mcp/tools.ts`, which the model reads anyway (TER-641 put the "how to fill
`sources`" detail on `send_input`/`send_key`, and left only a ~105-char pointer in the prompt). When
the budget is gone, shorten an existing rule rather than raising the cap.

## How to check

`cd apps/server && DATABASE_URL=postgresql://x:x@localhost:5432/x npx vitest run src/chat/concierge-prompt.test.ts`
passes. To see how much budget is left:
`npx tsx -e "import('./src/chat/concierge-prompt.ts').then(m => console.log(m.ORCHESTRATOR_PROMPT.length))"`
(should stay ≤ 3998).
