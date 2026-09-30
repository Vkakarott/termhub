# Chat: pending cards at hand — design

Card: **TER-477**. Related: TER-542 (a tab answer lost on a tall dialog, PR #249).

## 1. Problem

The chat shows two kinds of cards that wait on the person: the concierge's confirmations (`chat_actions`
with status `pending`) and the tabs' questions and permission prompts (`tab_questions`, open). Both sit in
the thread at the moment they were created, so a long conversation buries them. When the person asks
"manda aqui pra eu aprovar", the gate answers the concierge "esta ação ainda está aguardando" and nothing
reappears. A confirmation that went stale (the tab was closed or started asking a permission) only shows
as such after a reload, and then as a quiet "Falhou".

## 2. What changes

### 2.1 A pending bar, above the composer (web and phone)

- Shown only while something waits on the person: pending confirmations plus open tab questions and
  permission prompts. Suggestions are not counted: they never need an answer, and the sidebar dot does not count them either.
- Collapsed it is one line: "3 pendentes" plus a chevron. Expanded it lists each item in one line: the
  action's summary ("digitar … na aba …"), "A aba «x» pergunta: …", "«x» pede permissão para usar «tool»".
- Tapping an item scrolls the thread to its card and highlights it for a moment. The card itself stays
  where it is, so there is one place to answer and nothing to keep in sync.
- With two or more pending confirmations of class `write`, the bar offers "Aprovar as reversíveis (n)".
  It is the same batch call as the group card (`/actions/decisions`) with only those ids. Irreversible
  confirmations are left pending and are still decided one by one. This is the "same exceptions" rule of
  the group card, where irreversible rows start unchecked. Nothing new on the phone: `write` approves
  without a PIN there already (TER-92).

### 2.2 Bringing cards back to the end of the thread

- New nullable column `surfaced_at` on `chat_actions` and `tab_questions`. The thread orders a card by
  `surfaced_at ?? created_at`. The windowing rule, which hides cards older than the oldest loaded message, uses the same key.
- `resurfaceCards` sets `surfaced_at = now()` on a conversation's pending confirmations and open
  questions. For each row it publishes the usual event (`confirmation`, `tab_question`), carrying `surfaced_at` and
  `resurfaced: true`. The push service skips `resurfaced` events: the person was already told.
- The gate: a call whose identical proposal is still pending no longer only answers "já está aguardando".
  It resurfaces that one card and tells the concierge the card is back at the end of the chat.
- New MCP tool `recap_pending_cards`, for the chat token's conversation. It resurfaces everything pending
  and returns a short list (ids, summary or question, tab). It is self-mediated in the gate: it only moves
  cards on the person's own screen. The concierge prompt gains one line: when the person asks to see
  what is waiting on them, call it.

### 2.3 A stale or expired confirmation reads as such, live, with "Propor de novo"

- New bus event `action_status { action_id, status, error_code }`, published whenever the gate moves a
  row to `executed`, `failed` or `expired` (`execute`, `expireApproval`). The screens update the card
  without a reload. The hourly 24 h sweep does not publish: a reconnect re-reads, and a card a day old is
  seldom on screen.
- The card view carries `error_code`. A row `expired`, or `failed` with `TAB_GONE`,
  `WAITING_PERMISSION` or `PROMPT_CHANGED`, reads "Expirou" plus the reason ("a aba foi fechada", "a aba
  passou a pedir outra permissão") and offers **Propor de novo**. That button sends a chat message
  ("Proponha de novo: <summary>"), so the concierge re-proposes it through the gate as usual. No new
  route, and no way to run an action without a fresh card.

## 3. Impact on other users

- Everyone who uses the chat gets the bar, the resurfacing and the live status. This is default
  behaviour, not opt-in: it only shows what already waits on that person, and it hides itself when
  nothing does. No setting.
- Nothing is sent on anyone's behalf. "Aprovar as reversíveis" is one click on cards the person sees,
  and it never includes irreversible actions. "Propor de novo" only asks the concierge.
- Older phone apps strip unknown fields and drop unknown events. They keep ordering by `created_at` and
  update a stale card on the next re-read, exactly as today. The contract adds only optional fields and a
  new event type, never a new enum value.
- The migration adds two nullable columns: the previous release keeps working while the new one starts.

## 4. Testing

- Server: repository (`surfacePending`/`surfaceOpen`, on the database), gate (WAITING resurfaces, status
  events), the tool, push skipping `resurfaced`, route/view fields.
- Web: timeline order by `surfaced_at`, event handling (`action_status`, merged `surfaced_at`), the bar
  (count, list, scroll, batch), the expired card and "Propor de novo".
- Phone: contract, reducer, timeline, the bar (count, scroll through the list), the expired card.
