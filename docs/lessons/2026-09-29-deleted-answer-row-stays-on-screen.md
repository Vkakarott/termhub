---
symptom: "an answer bubble says \"pensando…\" for ever after a message typed while the concierge was running a tool, until the page is reloaded"
tags: [chat, web, mobile, events]
evidence: fixed
card: TER-416
agent: claude
date: 2026-09-29
---
## Cause

When a message typed during a tool call was merged into the running turn, the server deleted the
empty answer row it had announced and re-published the question. Its comments said the screens
re-read the conversation on that. No screen did: the web and the phone both merge `message` events
by id and never remove a row, and the web replaced the whole list on a re-read without knowing that
an older snapshot could still list the deleted row. The row stayed empty, and once the screen knew
it had started it showed "pensando…" for good.

## Fix

The server publishes `message_removed` at every deletion of an answer row. The web drops the row
from the thread and remembers the id (`removed()` in `apps/web/src/lib/chat-live.ts`), and a re-read
of the same conversation goes through `mergeThread` (`apps/web/src/lib/chat-merge.ts`): a removed row
is left out, a row the snapshot lacks is dropped unless it is newer, and a final row never goes back to
empty. "Newer" means its `message` event reached the page while the read was in flight, not a later
`created_at`: an answer is always newer than its question, so a comparison with the snapshot's newest
row kept a deleted answer; the rows a merge drops are also closed in the fold. `answering` looks at
every started empty row, not only the newest.
On the phone, `applyEvent` drops the row on `message_removed` and the store's re-read merges through `mergeThread` over the ids that arrived during the read, closing what it drops (`apps/mobile/src/features/chat/model/events.ts`).

Rule of thumb: a comment that says what another component does on an event is a claim to test in that
component, not in the one that publishes.

## How to check

`npm test -w @termhub/web -- src/components/chat/ChatPanel.test.tsx -t "removed row"`: the case
`a removed row leaves the thread, and "Nova conversa" is enabled again` fails when the
`message_removed` branch of `applyOwn` in `ChatPanel.tsx` is taken out, and passes with it.
