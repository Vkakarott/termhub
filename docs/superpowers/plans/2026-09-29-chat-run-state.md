# Chat Run State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A decision answers as soon as its run starts, and a screen always knows which answers are still to come, whenever it was opened.

**Architecture:** The server names every answer row that opens (`run_started`) and every one it deletes (`message_removed`), and lists the open ones in `GET`. The web and the phone keep a started set and a closed set, seeded from that list, and merge a re-read without ever moving a row backwards. The decision routes of the web await the start of the injected run instead of its end.

**Tech Stack:** Fastify, vitest, zod (`apps/server`, `packages/mobile-api`); React 19, vitest, jsdom (`apps/web`); Expo, zustand, jest (`apps/mobile`).

**Spec:** `docs/superpowers/specs/2026-09-29-chat-run-state-design.md`. Read it before any task: sections 2, 4 and 5 are the rules the code must follow.

## Global Constraints

- Code comments, identifiers, commit messages and pull request texts are in English. UI copy stays in Portuguese (pt-BR).
- Commit subject: imperative, at most 72 characters, prefixed by the area (`Chat:`, `Web:`, `Mobile:`, `Contract:`). A short body says why.
- Chat content is never logged: log ids and a failure's label (`failureLabel(err)`), never a message's text, a prompt or arguments.
- Routes never import Prisma. Every request input is validated with zod.
- Every chat feature lands on the phone too: the contract in `packages/mobile-api`, the mobile routes, the app.
- No database migration in this plan.
- The new UI sentence, verbatim: `O concierge não conseguiu começar a resposta. Tente de novo.`
- New event shapes, verbatim:
  `{ type: 'run_started'; user_id: string; conversation_id: string; message_id: string }` and
  `{ type: 'message_removed'; user_id: string; conversation_id: string; message_id: string }`.
- New response field, verbatim: `open_answer_ids: string[]`.
- In a pull request or commit text, never write close, fix or resolve (in any form) next to an issue number unless the issue must close. Cite with `Part of #157`.
- One commit per step that says "Commit". Never amend a commit that was already pushed.

### Running things on this machine (hulk, macOS)

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/termhub   # only parsed, no database is needed
npm run build -w @termhub/mobile-api          # after any change in packages/mobile-api, before the server tests
npm test -w @termhub/server -- <paths>
npm run typecheck -w @termhub/server
npm test -w @termhub/web -- <paths>
npm run typecheck -w @termhub/web
npm test -w @termhub/mobile -- <paths>
npm run typecheck -w @termhub/mobile
npm test -w @termhub/mobile-api
```

- `grep` and `cat` are aliased in the interactive shell; in scripts use `/usr/bin/grep` and `/bin/cat`.
- There is no Postgres here. Tests named `*.db.test.ts` are skipped without `TERMHUB_DB_TESTS=1`; CI runs them.
- **Known failures of the baseline on this machine, not caused by this plan:** three tests about `xlsx` in `apps/server/src/chat/attachments/extract.test.ts` (two) and `parsers.test.ts` (one). They pass in CI. Do not touch them. Any other failure is yours.

---

### Task 1: The server says when an answer row opens and when it is deleted

**Files:**
- Modify: `apps/server/src/chat/bus.ts`
- Modify: `packages/mobile-api/src/events.ts`
- Modify: `apps/server/src/mobile/events-parity.test.ts`
- Modify: `apps/server/src/chat/live-run.ts`
- Modify: `apps/server/src/chat/service.ts` (`finishRun`, `startWhileBusy`)
- Test: `apps/server/src/chat/live-run.test.ts`, `apps/server/src/chat/service.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the two events on `chatBus` and in `chatEventSchema`. Task 2 adds the read of the open rows; tasks 4 and 5 consume the events.

- [ ] **Step 1: Add the two events to the bus type**

In `apps/server/src/chat/bus.ts`, right after the `run_finished` member of `ChatEvent`:

```ts
  /** An answer row is open: a process has its turn, or the queue holds it for the next one. Published
   * after the row's own `message` event, and again when a queued row is taken by a process: screens
   * keep a set. Metadata only. */
  | { type: 'run_started'; user_id: string; conversation_id: string; message_id: string }
  /** An answer row was deleted: nothing will ever be written into it. Screens drop the row. */
  | { type: 'message_removed'; user_id: string; conversation_id: string; message_id: string }
```

- [ ] **Step 2: See the parity test refuse to compile**

Run: `npm run typecheck -w @termhub/server`
Expected: FAIL in `src/mobile/events-parity.test.ts`, the samples record lacks `run_started` and `message_removed`.

- [ ] **Step 3: Add the events to the mobile contract and their samples**

In `packages/mobile-api/src/events.ts`, inside `chatEventSchema`, right after the `run_finished` object:

```ts
  z.object({
    type: z.literal('run_started'),
    user_id: z.string(),
    conversation_id: z.string(),
    message_id: z.string(),
  }),
  z.object({
    type: z.literal('message_removed'),
    user_id: z.string(),
    conversation_id: z.string(),
    message_id: z.string(),
  }),
```

In `apps/server/src/mobile/events-parity.test.ts`, in the samples record, after `run_finished`:

```ts
  run_started: { type: 'run_started', ...base, message_id: 'm1' },
  message_removed: { type: 'message_removed', ...base, message_id: 'm1' },
```

Run: `npm run build -w @termhub/mobile-api && npm test -w @termhub/mobile-api && npm run typecheck -w @termhub/server && npm test -w @termhub/server -- src/mobile/events-parity.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing tests of `LiveRun`**

Append to `apps/server/src/chat/live-run.test.ts`. They use the file's own `harness`, `manualStream`, `replay`, `delta`, `result` and `settle`.

```ts
const typesOf = (events: ChatEvent[], id: string) =>
  events.filter((e) => ('message_id' in e && e.message_id === id) || (e.type === 'message' && e.message.id === id)).map((e) => e.type);

it('announces a turn it accepted with run_started, and says nothing for one it refused', async () => {
  const a = await h.turn(U1, 'a');
  expect(h.live.add(a.t)).toBe(true);
  expect(h.events.filter((e) => e.type === 'run_started')).toEqual([{ type: 'run_started', user_id: 'u1', conversation_id: 'c1', message_id: a.t.answer.id }]);

  h.live.endInput();
  const b = await h.turn(U2, 'b');
  expect(h.live.add(b.t)).toBe(false);
  expect(h.events.filter((e) => e.type === 'run_started')).toHaveLength(1);
});

it('a turn the CLI starts on its own publishes its message and then run_started', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('primeira'));
  s.push(result());
  await settle();
  const before = h.events.length;
  s.push(delta('por conta própria'));
  await settle();
  const own = h.events.slice(before);
  expect(own.map((e) => e.type)).toEqual(['message', 'run_started', 'delta']);
  expect((own[1] as { message_id: string }).message_id).toBe((own[0] as { message: ChatMessage }).message.id);
  s.end();
  await consumed;
});

it('a turn merged into the next one has its empty row removed, and says so', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  await settle();
  h.live.add(b.t);
  s.push(replay(U2));
  await settle();
  expect(h.events.filter((e) => e.type === 'message_removed')).toEqual([{ type: 'message_removed', user_id: 'u1', conversation_id: 'c1', message_id: a.t.answer.id }]);
  s.push(delta('as duas'));
  s.push(result());
  s.end();
  await consumed;
});

it('a turn the CLI started that said nothing has its row removed, and says so', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('resposta'));
  s.push(result());
  await settle();
  s.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu9', name: 'Read', input: {} }] } }));
  await settle();
  s.push(result());
  await settle();
  const removed = h.events.filter((e) => e.type === 'message_removed');
  expect(removed).toHaveLength(1);
  expect(h.rows.some((r) => r.id === (removed[0] as { message_id: string }).message_id)).toBe(false);
  s.end();
  await consumed;
});

it('abandon removes every open answer and says so for each', async () => {
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  a.done.catch(() => {});
  b.done.catch(() => {});
  h.live.add(a.t);
  h.live.add(b.t);
  await h.live.abandon(new Error('setup'));
  expect(h.events.filter((e) => e.type === 'message_removed').map((e) => (e as { message_id: string }).message_id)).toEqual([a.t.answer.id, b.t.answer.id]);
});

it('restart announces every waiting turn again, after its reset', async () => {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('meia'));
  await settle();
  s.end();
  await consumed;
  const before = h.events.length;
  await h.live.restart();
  expect(typesOf(h.events.slice(before), a.t.answer.id)).toEqual(['reset', 'run_started']);
});

/** A process that died while writing a turn the CLI started on its own, with a turn of the person's waiting. */
async function diedOnItsOwnTurn() {
  const a = await h.turn(U1, 'a');
  h.live.add(a.t);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('resposta'));
  s.push(result());
  await settle();
  const b = await h.turn(U2, 'b');
  h.live.add(b.t);
  s.push(delta('por conta própria'));
  await settle();
  const own = h.rows.find((r) => r.role === 'assistant' && r.id !== a.t.answer.id && r.id !== b.t.answer.id)!;
  s.end();
  await consumed;
  return { b, own };
}

it('restart removes the row of a turn the CLI started, after the waiting turns were announced', async () => {
  const { b, own } = await diedOnItsOwnTurn();
  const before = h.events.length;
  await h.live.restart();
  const after = h.events.slice(before);
  expect(h.rows.some((r) => r.id === own.id)).toBe(false);
  expect(h.live.storedTurns().map((t) => t.answer_id)).toEqual([b.t.answer.id]);
  const removedAt = after.findIndex((e) => e.type === 'message_removed' && e.message_id === own.id);
  const announcedAt = after.findIndex((e) => e.type === 'run_started' && e.message_id === b.t.answer.id);
  expect(announcedAt).toBeGreaterThanOrEqual(0);
  expect(removedAt).toBeGreaterThan(announcedAt);
});

it('a row restart could not remove strands nobody: the waiting turns wait again and nothing is announced as removed', async () => {
  const { b, own } = await diedOnItsOwnTurn();
  h.chat.deleteMessage.mockRejectedValueOnce(new Error('database down'));
  const before = h.events.length;
  await expect(h.live.restart()).resolves.toBeUndefined();
  expect(h.live.storedTurns().map((t) => t.answer_id)).toEqual([b.t.answer.id]);
  expect(h.events.slice(before).some((e) => e.type === 'message_removed')).toBe(false);
  expect(h.rows.some((r) => r.id === own.id)).toBe(true);
});
```

If a fixture of the file already produces a turn the CLI starts on its own (the background notification of `stream-background.ndjson`), prefer it to the hand-written frames of these tests. The tool call of the fourth test must be written in a frame shape `parseFrame` reads as an `action`: copy one from a fixture.

Run: `npm test -w @termhub/server -- src/chat/live-run.test.ts`
Expected: the new tests FAIL (no `run_started`, no `message_removed`).

- [ ] **Step 5: Publish from `LiveRun`**

In `apps/server/src/chat/live-run.ts`, add two private helpers next to `turnsChanged`:

```ts
  /** An answer row got its owner (this process): every open screen shows it as being answered. */
  private announce(messageId: string): void {
    chatBus.publish({ type: 'run_started', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: messageId });
  }

  /** An answer row was deleted: every open screen drops it. */
  private removed(messageId: string): void {
    chatBus.publish({ type: 'message_removed', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: messageId });
  }
```

Then:

1. `add`: after `if (turn.question) this.lastQuestion = turn.question;` add `this.announce(turn.answer.id);`.
2. `consume`, the merge branch: right after `await this.deps.chat.deleteMessage(prev.answer.id);` add `this.removed(prev.answer.id);`.
3. `abandon`: right after `await this.deps.chat.deleteMessage(t.answer.id);` add `this.removed(t.answer.id);`.
4. `answering`: after the `chatBus.publish({ type: 'message', ... message: answer })` line add `this.announce(answer.id);`.
5. `finishTurn`, the silent branch: right after `await this.deps.chat.deleteMessage(a.answer.id);` add `this.removed(a.answer.id);`.
6. `restart`: in the loop over `this.waiting`, after the `reset` publication, add `this.announce(t.answer.id);`. Then, as the last statement before `await this.deps.chat.setCliSession(...)`:

```ts
    // The row of a turn the CLI started on its own: nothing will be written into it now. Last and
    // best effort: the person's turns are already waiting again, and a failure here must not strand them.
    if (cur && cur.turn === null) await this.dropOwnRow(cur.answer.id);
```

with

```ts
  private async dropOwnRow(id: string): Promise<void> {
    try {
      await this.deps.chat.deleteMessage(id);
      this.removed(id);
      if (this.lastQuestion) chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: this.lastQuestion });
    } catch (err) {
      console.error('chat: the row of a turn the CLI started could not be removed', { conversation_id: this.deps.conversationId, error: failureLabel(err) });
    }
  }
```

Update the comments of `abandon`, `finishTurn` and the merge branch that say "the bus has no removed event".

Run: `npm test -w @termhub/server -- src/chat/live-run.test.ts`
Expected: PASS. An older test that compares a whole list of events may need the new events added to what it expects: add them, never filter them out of an assertion that was strict.

- [ ] **Step 6: Write the failing tests of the service**

Add to `apps/server/src/chat/service.test.ts`, in the `describe` that holds the one-shot run tests. Read the top of the file first: `build(lines, opts)` builds the service over in-memory repositories, a one-shot host is the default and `streaming: true` gives a streamed one. Use the helpers the neighbouring tests use to produce CLI lines (a text frame, a `done` frame) and to hold a run open (a generator that awaits a promise the test resolves).

Cases, each its own `it`:

1. `a one-shot run announces its row before anything streams`: subscribe to `chatBus`, `await service.send(user, 'oi')`, then for the answer's id the types in order are `['message', 'run_started', 'delta', 'message', 'run_finished']` (one `delta` per text frame of the fixture used).
2. `a message queued behind a process that takes no input is announced once`: a streamed run is held open with its input ended (the neighbouring tests about the queue show how), `service.start(user, 'segunda')` resolves, and exactly one `run_started` names its `assistant_message_id` before the held run is released.
3. `a one-shot run that could not be attempted says its row was removed`: the runner throws the setup failure the neighbouring test `isSetupFailure` uses; the events contain `message_removed` for the answer's id, then `run_finished` with `message_id: null`, and `send` rejects as before.
4. The same for the retry on a fresh session (the second place `finishRun` deletes the row).

Run: `npm test -w @termhub/server -- src/chat/service.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 7: Publish from the service**

In `apps/server/src/chat/service.ts`:

1. `finishRun`, first statement inside its `try`:

```ts
      chatBus.publish({ type: 'run_started', user_id: user.id, conversation_id: conversation.id, message_id: answer.id });
```

2. `finishRun`, in both `isSetupFailure` branches, right after `await this.deps.repos.chat.deleteMessage(answer.id);`:

```ts
            chatBus.publish({ type: 'message_removed', user_id: user.id, conversation_id: conversation.id, message_id: answer.id });
```

   and replace the comment "the bus has no removed event" by one that says the question is still re-published for screens that predate `message_removed`.

3. `startWhileBusy`, right after `this.enqueue(...)` and before the `launchQueued` line:

```ts
    // Announced here, before the queue may run: `launchQueued` can close this turn at once.
    chatBus.publish({ type: 'run_started', user_id: user.id, conversation_id: conversation.id, message_id: answer.id });
```

Run: `npm test -w @termhub/server -- src/chat src/routes/chat.test.ts src/routes/m-chat.test.ts src/mobile && npm run typecheck -w @termhub/server`
Expected: PASS, except the three known `xlsx` failures.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/chat apps/server/src/mobile/events-parity.test.ts packages/mobile-api/src/events.ts
git commit -m "Chat: say when an answer row opens and when it is deleted" -m "Screens inferred both from what they happened to see. run_started names a row that got an owner, message_removed one that was deleted; restart now removes the row of a turn the CLI started, which it used to leave open for ever."
```

---

### Task 2: `GET` lists the answers that are still to come

**Files:**
- Create: `apps/server/src/chat/open-answers.ts`
- Test: `apps/server/src/chat/open-answers.test.ts`
- Modify: `apps/server/src/chat/live-run.ts` (`openAnswerIds`)
- Modify: `apps/server/src/chat/service.ts` (`oneShot`, `openAnswerIds`)
- Modify: `apps/server/src/routes/chat.ts`, `apps/server/src/routes/m-chat.ts` (`GET /`)
- Test: `apps/server/src/chat/live-run.test.ts`, `apps/server/src/chat/service.test.ts`, `apps/server/src/routes/chat.test.ts`, `apps/server/src/routes/m-chat.test.ts`

**Interfaces:**
- Consumes: Task 1 (`finishRun` announces its row at its first statement).
- Produces: `open_answer_ids: string[]` in `GET /api/chat` and in the mobile `GET`; `ChatService.openAnswerIds(conversationId: string): Promise<string[]>`; `openAnswersIn(messages, open): string[]`.

- [ ] **Step 1: Write the failing test of the pure filter**

`apps/server/src/chat/open-answers.test.ts`:

```ts
import { expect, it } from 'vitest';
import { openAnswersIn } from './open-answers.js';

const row = (id: string, role: 'user' | 'assistant', text = '', error_code: string | null = null) => ({ id, role, text, error_code });

it('keeps only the empty assistant rows that are open, in the order of the thread', () => {
  const messages = [row('q1', 'user', 'oi'), row('a1', 'assistant', 'olá'), row('q2', 'user', 'e agora?'), row('a2', 'assistant'), row('q3', 'user', 'mais'), row('a3', 'assistant')];
  expect(openAnswersIn(messages, ['a3', 'a2', 'a1'])).toEqual(['a2', 'a3']);
});

it('leaves out a row that ended in an error, a row of the person and an id the thread lacks', () => {
  const messages = [row('q1', 'user', ''), row('a1', 'assistant', '', 'RUN_FAILED'), row('a2', 'assistant')];
  expect(openAnswersIn(messages, ['q1', 'a1', 'gone'])).toEqual([]);
});

it('lists an id once, however many sources named it', () => {
  expect(openAnswersIn([row('a1', 'assistant')], ['a1', 'a1'])).toEqual(['a1']);
});

it('an empty row nobody owns is not open', () => {
  expect(openAnswersIn([row('a1', 'assistant')], [])).toEqual([]);
});
```

Run: `npm test -w @termhub/server -- src/chat/open-answers.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 2: Write the filter**

`apps/server/src/chat/open-answers.ts`:

```ts
/** The part of a stored message this needs. */
export interface ThreadRow {
  id: string;
  role: string;
  text: string;
  error_code: string | null;
}

/**
 * The ids of `open` that `messages` lists as an assistant row with no text and no error, in the order
 * of `messages`. What `GET /api/chat` answers as `open_answer_ids`: the rows a screen shows as being
 * answered. The two lists are read at different moments; a row that ended in between has text or an
 * error by now, and an id the thread no longer has is left out.
 */
export function openAnswersIn(messages: readonly ThreadRow[], open: readonly string[]): string[] {
  const ids = new Set(open);
  return messages.filter((m) => m.role === 'assistant' && m.text === '' && m.error_code === null && ids.has(m.id)).map((m) => m.id);
}
```

Run: `npm test -w @termhub/server -- src/chat/open-answers.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing test of `LiveRun.openAnswerIds`**

Append to `apps/server/src/chat/live-run.test.ts`:

```ts
it('lists the answers it still owes: the one being written, then the waiting ones', async () => {
  expect(h.live.openAnswerIds()).toEqual([]);
  const a = await h.turn(U1, 'a');
  const b = await h.turn(U2, 'b');
  h.live.add(a.t);
  h.live.add(b.t);
  expect(h.live.openAnswerIds()).toEqual([a.t.answer.id, b.t.answer.id]);
  const s = manualStream();
  const consumed = h.live.consume(s.stream);
  s.push(replay(U1));
  s.push(delta('resposta'));
  s.push(result());
  await settle();
  expect(h.live.openAnswerIds()).toEqual([b.t.answer.id]);
  s.push(replay(U2));
  s.push(delta('outra'));
  s.push(result());
  await settle();
  expect(h.live.openAnswerIds()).toEqual([]);
  s.push(delta('por conta própria'));
  await settle();
  expect(h.live.openAnswerIds()).toHaveLength(1);
  s.end();
  await consumed;
});
```

Run: `npm test -w @termhub/server -- src/chat/live-run.test.ts`
Expected: FAIL, `openAnswerIds` is not a function.

- [ ] **Step 4: Write `LiveRun.openAnswerIds`**

In `apps/server/src/chat/live-run.ts`, after `storedTurns`:

```ts
  /** The answer rows this process still owes: the one being written (a turn of the person's or one
   *  the CLI started on its own), then the waiting ones. A merged turn has no row of its own. */
  openAnswerIds(): string[] {
    return [...(this.current ? [this.current.answer.id] : []), ...this.waiting.map((t) => t.answer.id)];
  }
```

Run: `npm test -w @termhub/server -- src/chat/live-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests of `ChatService.openAnswerIds`**

Add to `apps/server/src/chat/service.test.ts`. The in-memory `chatLiveRuns` of `build` already has `findResumable`; the test seeds its store through `chatLiveRuns.save` followed by `chatLiveRuns.release`, with an `instance_id` that is not the service's.

Cases:

1. `lists the row of a one-shot run while it runs, and nothing after`: hold the run open, `await service.start(...)`, expect `await service.openAnswerIds('c1')` to equal `[assistant_message_id]`; release, await `done`, expect `[]`.
2. `lists the rows of a streamed process, and nothing once only subagents keep it alive`: streamed host, a turn answered while a background task is reported (the background fixture); after the turn ends and before the process exits, expect `[]`.
3. `lists a message queued behind a process that ended its input`.
4. `lists the open turns of a row another instance released`: save a row `{ conversation_id: 'c1', user_id: 'u1', instance_id: 'other', turns: [{ question_id: 'q', answer_id: 'a-open', text: 'x' }] }`, release it, expect `['a-open']`.
5. `leaves out a row that is alive in another instance`: the same row, not released, fresh heartbeat: expect `[]`.
6. `a failed read of the table costs only that part`: `chatLiveRuns.findResumable.mockRejectedValueOnce(new Error('down'))` while a one-shot run is held open: expect the run's row, and no rejection.

Run: `npm test -w @termhub/server -- src/chat/service.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 6: Write `ChatService.openAnswerIds`**

In `apps/server/src/chat/service.ts`:

1. A field, next to `queued`:

```ts
  /** The answer row of a one-shot run, while it runs: what `openAnswerIds` lists for it. */
  private oneShot = new Map<string, string>();
```

2. `finishRun`: `this.oneShot.set(conversation.id, answer.id);` as the first statement inside its `try`, before the `run_started` publication; and in its `finally`, `this.oneShot.delete(conversation.id);` **before** `this.releaseLock(...)` (the release may start the next queued run, which sets its own row).

3. The method, after `isCompacting`:

```ts
  /**
   * The answer rows of a conversation that are still to be answered, for `GET /api/chat`. The union of
   * what this instance holds (the live process's open turns, the row of a one-shot run, the queued
   * turns) and the turns of the conversation's row in `chat_live_runs` when another instance released
   * it or left it stale: that row is resumed or closed here, and both are published here. A row alive
   * in another instance is left out on purpose: the bus is in-process, so its end would never reach a
   * screen connected to this one.
   *
   * A closed row is closed for good: nothing may write into a row that already had its final
   * `message` or was removed, or screens would never show it.
   */
  async openAnswerIds(conversationId: string): Promise<string[]> {
    const ids = new Set<string>(this.live.get(conversationId)?.openAnswerIds() ?? []);
    const oneShot = this.oneShot.get(conversationId);
    if (oneShot !== undefined) ids.add(oneShot);
    for (const q of this.queued.get(conversationId) ?? []) ids.add(q.answer.id);
    try {
      const row = await this.deps.repos.chatLiveRuns.findResumable(conversationId, this.instanceId, new Date(Date.now() - STALE_MS));
      for (const t of row?.turns ?? []) if (t.answer_id !== null) ids.add(t.answer_id);
    } catch (err) {
      console.error('chat: the open turns of another instance could not be read', { conversation_id: conversationId, error: failureLabel(err) });
    }
    return [...ids];
  }
```

Run: `npm test -w @termhub/server -- src/chat/service.test.ts && npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 7: Write the failing tests of the two routes**

In `apps/server/src/routes/chat.test.ts`, the service stand-in of `build` gains `openAnswerIds: opts.openAnswerIds ?? vi.fn(async () => [])` (add `openAnswerIds?: ReturnType<typeof vi.fn>` to the options). Then:

```ts
it('GET / lists the answers still to come, only among the empty rows it returns', async () => {
  const { app, repos } = build({ openAnswerIds: vi.fn(async () => ['m-open', 'm-done', 'm-gone']) });
  repos.chat.listMessages = vi.fn(async () => [
    { id: 'm-q', role: 'user', text: 'oi', error_code: null },
    { id: 'm-done', role: 'assistant', text: 'pronto', error_code: null },
    { id: 'm-open', role: 'assistant', text: '', error_code: null },
    { id: 'm-dead', role: 'assistant', text: '', error_code: null },
  ]) as never;
  const res = await app.inject({ method: 'GET', url: '/chat' });
  expect(res.statusCode).toBe(200);
  expect(res.json().open_answer_ids).toEqual(['m-open']);
});

it('GET / answers an empty list when nothing is being answered', async () => {
  const { app } = build();
  expect((await app.inject({ method: 'GET', url: '/chat' })).json().open_answer_ids).toEqual([]);
});
```

Adapt the way the rows are given to the way `build` of that file already seeds `listMessages`. Write the same two tests in `apps/server/src/routes/m-chat.test.ts`, with that file's own `build` and its authenticated request helper.

Run: `npm test -w @termhub/server -- src/routes/chat.test.ts src/routes/m-chat.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 8: Answer the list in both routes**

`apps/server/src/routes/chat.ts`, `GET /`: add `deps.service.openAnswerIds(conversation.id)` as the last entry of the `Promise.all` (name it `open`), import `openAnswersIn` from `'../chat/open-answers.js'`, and add to the response:

```ts
      // The rows a screen opened in the middle of a run shows as being answered (spec 2026-09-29).
      open_answer_ids: openAnswersIn(messages, open),
```

`apps/server/src/routes/m-chat.ts`, `GET /`: the same, with `deps.chat.openAnswerIds(conversation.id)`.

Run: `npm test -w @termhub/server -- src/chat src/routes/chat.test.ts src/routes/m-chat.test.ts src/mobile && npm run typecheck -w @termhub/server`
Expected: PASS, except the three known `xlsx` failures.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/chat apps/server/src/routes/chat.ts apps/server/src/routes/chat.test.ts apps/server/src/routes/m-chat.ts apps/server/src/routes/m-chat.test.ts
git commit -m "Chat: GET lists the answers that are still to come" -m "A screen opened in the middle of a run had no way to tell an answer being written from one that died. A process kept alive only by subagents owes no answer, so it lists nothing."
```

---

### Task 3: A decision answers when its run starts

**Files:**
- Modify: `apps/server/src/chat/service.ts` (`startAfterDecision`, `resumeAfterDecision`)
- Modify: `apps/server/src/routes/chat.ts` (the two decision routes, `POST /messages`)
- Modify: `apps/web/src/lib/api.ts` (response types)
- Test: `apps/server/src/chat/service.test.ts`, `apps/server/src/routes/chat.test.ts`
- Create: `docs/lessons/2026-09-29-decision-request-held-for-the-whole-answer.md`

**Interfaces:**
- Consumes: `ChatService.startIn` and `StartedRun`, which exist.
- Produces: `ChatService.startAfterDecision(user: User, action: ChatAction): Promise<StartedRun | undefined>`. The decision responses no longer carry `message`. `POST /api/chat/messages` always answers 202 `{ conversation_id, user_message_id, assistant_message_id }`.

- [ ] **Step 1: Write the failing tests of the service**

Add to `apps/server/src/chat/service.test.ts`, next to the tests of `resumeAfterDecision`:

1. `startAfterDecision resolves when the run has started, not when it ends`: a runner held open by a promise; `const started = await service.startAfterDecision(user, action())` resolves while the runner is held; `started` has the three ids; the decision is marked injected (`chatActions.markInjectedMany` called with `['a1']`); release the runner and `await started!.done`.
2. `startAfterDecision answers undefined when another run carried the decision first`: the store seeded with the action already injected.
3. `startAfterDecision refuses as before`: an archived conversation rejects with code `CHAT_ARCHIVED`; a one-shot run holding the lock rejects with `CHAT_BUSY` and marks nothing.
4. `a run that fails after startAfterDecision is never an unhandled rejection`: register `process.on('unhandledRejection', spy)`, make the runner throw the setup failure after `startAfterDecision` resolved, wait 20 ms, expect the spy not called, remove the listener in `finally`.
5. `resumeAfterDecision still awaits the whole run and still rejects with its failure`: the existing tests already cover the first half; add the rejection.

Run: `npm test -w @termhub/server -- src/chat/service.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 2: Write `startAfterDecision`**

Replace `resumeAfterDecision` in `apps/server/src/chat/service.ts` by the two methods. The long comment above it stays, on `startAfterDecision`, with "`sendIn` throws" reworded to "`startIn` throws".

```ts
  async startAfterDecision(user: User, action: ChatAction): Promise<StartedRun | undefined> {
    const conversation = await this.deps.repos.chat.findByIdForUser(action.conversation_id, user.id);
    // `decide` already proved the row is this user's; a conversation archived since then has nobody
    // reading it, and `reset` expired its open rows — nothing to inject.
    if (!conversation || conversation.archived_at !== null) throw new HttpError(409, 'Esta conversa foi encerrada', 'CHAT_ARCHIVED');
    // Re-read: the phone resumes in the background, and a drain may have carried this decision since
    // `decide` returned it. Injected once is injected for good — then only the others go, if any.
    const current = (await this.deps.repos.chatActions.findByIdForUser(action.id, user.id)) ?? action;
    const rest = await this.deps.repos.chatActions.listToInject(conversation.id, [action.id]);
    const batch = current.injected_at === null ? [action, ...rest] : rest;
    if (batch.length === 0) return undefined;
    try {
      const started = await this.startIn(user, conversation, await this.injectionFor(user, batch, conversation.cli_session_id === null), {
        beforeRun: () => this.markBatchInjected(batch),
      });
      // Nobody has to await the answer: it reaches the screens over the chat's stream, and a run
      // that could not be attempted says so there (`run_finished` with no message). The label only.
      started.done.catch((err) => console.error('chat: a run started by a decision failed', { conversation_id: conversation.id, action_id: action.id, error: failureLabel(err) }));
      return started;
    } catch (err) {
      // Another run carried part of the batch first: nothing was marked nor sent, and the drain the
      // released lock schedules picks up whatever is still waiting.
      if (err instanceof HttpError && err.code === ALREADY_INJECTED) return undefined;
      throw err;
    }
  }

  /** `startAfterDecision`, then the whole run: for a caller that wants the answer (the phone's routes,
   *  in the background). Rejects when the run does. */
  async resumeAfterDecision(user: User, action: ChatAction): Promise<ChatMessage | undefined> {
    return (await this.startAfterDecision(user, action))?.done;
  }
```

Run: `npm test -w @termhub/server -- src/chat/service.test.ts && npm run typecheck -w @termhub/server`
Expected: PASS.

- [ ] **Step 3: Rewrite the route tests to the new behaviour**

In `apps/server/src/routes/chat.test.ts`:

1. `build`: the service stand-in gains `startAfterDecision: opts.startAfterDecision ?? vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done: Promise.resolve({ id: 'ma' }) }))`, returned by `build` too. Every decision test that passes or reads `resumeAfterDecision` passes or reads `startAfterDecision` instead; the route must never call `resumeAfterDecision` (assert it once: `expect(service.resumeAfterDecision).not.toHaveBeenCalled()` in the first approval test).
2. New test:

```ts
it('a decision answers while the run it started is still being written', async () => {
  const done = new Promise(() => {});
  const { app } = build({ startAfterDecision: vi.fn(async () => ({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma', done })) });
  const res = await app.inject({ method: 'POST', url: '/chat/actions/act1/decision', payload: { decision: 'approve' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ action: { id: 'act1', status: 'approved' } });
  expect(res.json().message).toBeUndefined();
});
```

   and the same for `POST /chat/actions/decisions`.
3. The tests `sends a message and answers with the assistant row` and `without the flag, still waits for the answer and never calls start` become one: `POST /messages answers 202 with the three ids, with or without the flag`, which posts twice (`{ text: 'oi' }` and `{ text: 'oi', wait: false }`), expects 202 and the three ids both times, and `expect(send).not.toHaveBeenCalled()`.
4. Every other test that expected 201 or `message` from `POST /messages` (the attachment one, the ones that surface 503 and 502 through `send`) is rewritten over `start`: a refusal thrown by `start` keeps its status; a failure of `done` after the 202 is covered by the existing test `a run that fails after the 202 never becomes an unhandled rejection`.

Run: `npm test -w @termhub/server -- src/routes/chat.test.ts`
Expected: the rewritten and new tests FAIL.

- [ ] **Step 4: Change the routes**

In `apps/server/src/routes/chat.ts`:

1. `POST /messages`:

```ts
  app.post('/messages', { config: { action: 'create' } }, async (request, reply) => {
    // `wait` is read and ignored: a page loaded before this release still sends it.
    const { text, project_id, attachment_ids } = messageBody.parse(request.body);
    // `attachmentIds` only when the body carried ids, so a plain message calls the service exactly as before.
    const opts = { projectId: project_id ?? null, ...(attachment_ids ? { attachmentIds: attachment_ids } : {}) };
    // A refusal (host problem, archived conversation, an attachment that is not this user's) rejects
    // `start` itself and keeps its status. The answer streams over `/ws/chat`; a failure after this
    // point is logged by label, and a run that could not be attempted says so on the stream.
    const started = await deps.service.start(request.scope.user, text, opts);
    started.done.catch((err) => request.log.warn({ code: failureLabel(err), conversationId: started.conversation_id }, 'chat run failed after start'));
    return reply.code(202).send({ conversation_id: started.conversation_id, user_message_id: started.user_message_id, assistant_message_id: started.assistant_message_id });
  });
```

   and reword the comment of `messageBody`: `wait` is accepted for pages loaded before 2026-09-29 and ignored.

2. The single decision route, its last block:

```ts
    try {
      // Awaits the start of the injected run, never its end: an answer longer than the edge allows
      // used to cut this request and show an error for a decision that was recorded.
      await deps.service.startAfterDecision(user, action);
      return { action, grant, project_grant, standing_grant };
    } catch (err) {
      // (the existing comment about CHAT_BUSY stays)
      if (err instanceof HttpError && err.code === 'CHAT_BUSY') return { action, queued: true, note: QUEUED_NOTE, grant, project_grant, standing_grant };
      throw err;
    }
```

3. The batch route: `await deps.service.startAfterDecision(user, decided[0]!); return { actions: decided, skipped };` with the same `catch`.

In `apps/web/src/lib/api.ts`, remove `message?: ChatMessage;` from the response types of `decideChatAction` and `decideChatActions`, and fix their comments.

Run: `npm test -w @termhub/server -- src/chat src/routes && npm run typecheck -w @termhub/server && npm run typecheck -w @termhub/web`
Expected: PASS, except the three known `xlsx` failures.

- [ ] **Step 5: Write the lesson**

`docs/lessons/2026-09-29-decision-request-held-for-the-whole-answer.md`, in the format of `docs/lessons/README.md` (read it), with:

- symptom: `"Não foi possível registrar a decisão" on a card that was approved, when the answer takes longer than about 100 seconds`
- tags: `[chat, decisions, edge-timeout]`, evidence: `fixed` only if a test reproduces the held request, else `observed`; card: `TER-416`.
- Cause: the route awaited the run's end; the edge cut the request; the decision was already stored and published.
- Fix: await the start (`startAfterDecision`), let the stream carry the answer and the failure to start.
- Rule of thumb: a route that starts work that can outlive the edge's limit answers when the work has started, and the rejection of what it no longer awaits gets a `catch`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/chat/service.ts apps/server/src/chat/service.test.ts apps/server/src/routes/chat.ts apps/server/src/routes/chat.test.ts apps/web/src/lib/api.ts docs/lessons/2026-09-29-decision-request-held-for-the-whole-answer.md
git commit -m "Chat: a decision answers when its run starts" -m "The web's decision routes awaited the whole injected run, so an answer longer than the edge allows showed an error for a decision that was recorded. POST /messages loses the path that awaited the answer: only tests took it."
```

---

### Task 4: The web follows the server's word

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`ChatEvent`)
- Modify: `apps/web/src/lib/api.ts` (`chat` response type)
- Modify: `apps/web/src/lib/chat-live.ts`
- Modify: `apps/web/src/lib/chat-merge.ts`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`
- Test: `apps/web/src/lib/chat-live.test.ts`, `apps/web/src/lib/chat-merge.test.ts` (create if missing), `apps/web/src/components/chat/ChatPanel.test.tsx`
- Create: `docs/lessons/2026-09-29-deleted-answer-row-stays-on-screen.md`

**Interfaces:**
- Consumes: the events of Task 1 and `open_answer_ids` of Task 2. The page must also work against a server that sends neither.
- Produces: nothing other tasks use.

**Changed after the review of Task 4:** rule 3 of a re-read does not compare `created_at`. A row
the snapshot lacks is kept only when its `message` event reached the screen while that read was in
flight, and the rows a merge drops are closed in the fold. `mergeThread` takes the set of ids that
arrived during the read in place of the comparison. Where the snippets of this task compare
`created_at` with the newest row of the snapshot, use that set.

- [ ] **Step 1: Types**

`apps/web/src/lib/types.ts`, in `ChatEvent`:

```ts
  /** An answer row is open: a process has its turn, or the queue holds it. Sent again when a queued row is taken. */
  | { type: 'run_started'; message_id: string; conversation_id?: string }
  /** A run ended. With no `message_id` it could not even be attempted, and its answer row is gone. */
  | { type: 'run_finished'; message_id: string | null; ok: boolean; error_code: string | null; conversation_id?: string }
  /** An answer row was deleted on the server: drop it. */
  | { type: 'message_removed'; message_id: string; conversation_id?: string }
```

`apps/web/src/lib/api.ts`, the response type of `chat`: add `open_answer_ids?: string[]`.

- [ ] **Step 2: Write the failing tests of the fold**

In `apps/web/src/lib/chat-live.test.ts`, replace the test `a reset drops what streamed for that id` and add the rest:

```ts
const final = (id: string, text = 'pronto'): ChatEvent => ({ type: 'message', conversation_id: 'c1', message: { id, conversation_id: 'c1', role: 'assistant', text, error_code: null, created_at: '' } as ChatMessage });

it('a reset drops what streamed for that id and keeps the row started', () => {
  const fold = createLiveFold();
  fold.apply(action('m1', 'Bash'));
  fold.apply(delta('m1', 'meia resposta'));
  expect(fold.apply({ type: 'reset', message_id: 'm1' })).toBe(true);
  expect(fold.get('m1')).toEqual({ text: '', tools: [], started: true });
});

it('a reset of an id it never saw changes nothing and creates nothing', () => {
  const fold = createLiveFold();
  expect(fold.apply({ type: 'reset', message_id: 'nobody' })).toBe(false);
  expect(fold.get('nobody')).toBeUndefined();
});

it('run_started marks a row started, once', () => {
  const fold = createLiveFold();
  expect(fold.apply({ type: 'run_started', message_id: 'm1' })).toBe(true);
  expect(fold.get('m1')).toEqual({ text: '', tools: [], started: true });
  expect(fold.apply({ type: 'run_started', message_id: 'm1' })).toBe(false);
});

it('seed marks the rows the server says are open', () => {
  const fold = createLiveFold();
  expect(fold.seed(['m1', 'm2'])).toBe(true);
  expect(fold.get('m1')?.started).toBe(true);
  expect(fold.get('m2')?.started).toBe(true);
  expect(fold.seed(['m1'])).toBe(false);
});

it('a row that ended is closed for good: nothing opens it again', () => {
  const fold = createLiveFold();
  fold.apply(announce('m1'));
  fold.apply(final('m1'));
  expect(fold.isClosed('m1')).toBe(true);
  expect(fold.seed(['m1'])).toBe(false);
  expect(fold.apply({ type: 'run_started', message_id: 'm1' })).toBe(false);
  expect(fold.apply(announce('m1'))).toBe(false);
  expect(fold.get('m1')).toBeUndefined();
});

it('run_finished closes its row, and with no row it changes nothing', () => {
  const fold = createLiveFold();
  fold.apply({ type: 'run_started', message_id: 'm1' });
  expect(fold.apply({ type: 'run_finished', message_id: 'm1', ok: true, error_code: null })).toBe(true);
  expect(fold.isClosed('m1')).toBe(true);
  expect(fold.apply({ type: 'run_finished', message_id: null, ok: false, error_code: 'SETUP_FAILED' })).toBe(false);
});

it('message_removed closes the row and remembers it was removed', () => {
  const fold = createLiveFold();
  fold.apply({ type: 'run_started', message_id: 'm1' });
  const before = fold.removed();
  expect(fold.apply({ type: 'message_removed', message_id: 'm1' })).toBe(true);
  expect(fold.get('m1')).toBeUndefined();
  expect(fold.isClosed('m1')).toBe(true);
  expect(fold.removed().has('m1')).toBe(true);
  expect(fold.removed()).not.toBe(before);
});

it('a removal of a row it never had is remembered too', () => {
  const fold = createLiveFold();
  fold.apply({ type: 'message_removed', message_id: 'ghost' });
  expect(fold.removed().has('ghost')).toBe(true);
  expect(fold.seed(['ghost'])).toBe(false);
});

it('clear forgets everything: another conversation is on screen', () => {
  const fold = createLiveFold();
  fold.apply(delta('m1', 'x'));
  fold.apply(final('m2'));
  fold.apply({ type: 'message_removed', message_id: 'm3' });
  fold.clear();
  expect(fold.get('m1')).toBeUndefined();
  expect(fold.isClosed('m2')).toBe(false);
  expect(fold.removed().size).toBe(0);
});
```

Also change, in `ignores what is not its business`, nothing: a reset of `'nobody'` still returns false.

Run: `npm test -w @termhub/web -- src/lib/chat-live.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite the fold**

`apps/web/src/lib/chat-live.ts`: the interface and the factory become

```ts
export interface LiveFold {
  /** Folds one event in. `true` when a row changed (and `version` moved). */
  apply(ev: ChatEvent): boolean;
  get(messageId: string): LiveRow | undefined;
  /** Marks the rows the server lists as still to be answered (`open_answer_ids`), except closed ones.
   *  Add-only: a row is never unmarked because the list lacks it. */
  seed(ids: readonly string[]): boolean;
  /** Forgets everything: the panel shows another conversation now. */
  clear(): void;
  /** The row had its final `message`, its `run_finished` or was removed: nothing opens it again. */
  isClosed(messageId: string): boolean;
  /** The ids of the rows the server deleted. A new set each time one is added. */
  removed(): ReadonlySet<string>;
  /** Counts changes; a React consumer stores it in state to re-render. */
  version: number;
}

export function createLiveFold(): LiveFold {
  const rows = new Map<string, LiveRow>();
  const closed = new Set<string>();
  let removed: ReadonlySet<string> = new Set<string>();

  const start = (id: string): boolean => {
    if (closed.has(id)) return false;
    const row = rows.get(id);
    if (row?.started) return false;
    rows.set(id, row ? { ...row, started: true } : { text: '', tools: NO_TOOLS, started: true });
    return true;
  };
  const close = (id: string): boolean => {
    closed.add(id);
    return rows.delete(id);
  };

  const fold: LiveFold = {
    version: 0,
    get: (id) => rows.get(id),
    isClosed: (id) => closed.has(id),
    removed: () => removed,
    seed(ids) {
      let changed = false;
      for (const id of ids) changed = start(id) || changed;
      if (changed) fold.version += 1;
      return changed;
    },
    clear() {
      rows.clear();
      closed.clear();
      removed = new Set<string>();
      fold.version += 1;
    },
    apply(ev) {
      let changed = false;
      switch (ev.type) {
        case 'delta': {
          if (closed.has(ev.message_id)) break;
          const row = rows.get(ev.message_id) ?? EMPTY_ROW;
          rows.set(ev.message_id, { text: row.text + ev.delta, tools: row.tools, started: true });
          changed = true;
          break;
        }
        case 'action': {
          if (closed.has(ev.message_id)) break;
          const row = rows.get(ev.message_id) ?? EMPTY_ROW;
          rows.set(ev.message_id, { text: row.text, tools: [...row.tools, { tool: ev.tool }], started: true });
          changed = true;
          break;
        }
        case 'reset': {
          // The server retried the run on a fresh session: the half-answer goes, the run is alive.
          const row = rows.get(ev.message_id);
          if (row && (row.text !== '' || row.tools.length > 0)) {
            rows.set(ev.message_id, { text: '', tools: NO_TOOLS, started: row.started });
            changed = true;
          }
          break;
        }
        case 'run_started':
          changed = start(ev.message_id);
          break;
        case 'run_finished':
          if (ev.message_id !== null) changed = close(ev.message_id);
          break;
        case 'message_removed':
          changed = close(ev.message_id);
          removed = new Set(removed).add(ev.message_id);
          changed = true;
          break;
        case 'message': {
          const m = ev.message;
          if (m.role !== 'assistant') {
            changed = rows.delete(m.id);
          } else if (!m.text && !m.error_code) {
            // The announcement of a run: an assistant row with nothing in it yet.
            changed = start(m.id);
          } else {
            // The stored row (text, or the error it ended in): the panel merges it into `messages` in
            // the same event, so what streamed for it is let go of here.
            changed = close(m.id);
          }
          break;
        }
        default:
          break;
      }
      if (changed) fold.version += 1;
      return changed;
    },
  };
  return fold;
}
```

`useChatLive` returns `seed` and `clear` too, both stable (`useCallback` over `fold`), each calling `setVersion(fold.version)` after the fold changed.

Run: `npm test -w @termhub/web -- src/lib/chat-live.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing tests of the merge**

`apps/web/src/lib/chat-merge.test.ts` (add to it if it exists):

```ts
import { describe, expect, it } from 'vitest';
import { mergeMessage, mergeThread } from './chat-merge';
import type { ChatMessage } from './types';

const row = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, conversation_id: 'c1', role: 'assistant', text: '', error_code: null, created_at: '2026-09-29T10:00:00.000Z', ...over }) as ChatMessage;
const NONE: ReadonlySet<string> = new Set();

describe('mergeMessage', () => {
  it('never moves a row from final back to empty', () => {
    const list = [row('a1', { text: 'pronto' })];
    expect(mergeMessage(list, row('a1'))).toBe(list);
    const failed = [row('a1', { error_code: 'RUN_FAILED' })];
    expect(mergeMessage(failed, row('a1'))).toBe(failed);
  });
});

describe('mergeThread', () => {
  it('keeps the final row the screen holds over the empty one of an older snapshot', () => {
    const current = [row('a1', { text: 'pronto' })];
    expect(mergeThread(current, [row('a1')], NONE)).toBe(current);
  });

  it('leaves out a row the screen saw removed', () => {
    expect(mergeThread([], [row('a1'), row('a2')], new Set(['a1'])).map((m) => m.id)).toEqual(['a2']);
  });

  it('drops a row the snapshot lacks, unless it is newer than the snapshot', () => {
    const current = [row('old', { created_at: '2026-09-29T09:00:00.000Z' }), row('a1'), row('new', { created_at: '2026-09-29T11:00:00.000Z' })];
    expect(mergeThread(current, [row('a1')], NONE).map((m) => m.id)).toEqual(['a1', 'new']);
  });

  it('takes the snapshot for every other row, in the snapshot order', () => {
    const current = [row('a1'), row('a2')];
    const next = mergeThread(current, [row('a1', { text: 'agora' }), row('a2')], NONE);
    expect(next.map((m) => m.text)).toEqual(['agora', '']);
    expect(next[1]).toBe(current[1]);
  });

  it('answers the very same list when nothing changed', () => {
    const current = [row('a1', { text: 'x' }), row('a2')];
    expect(mergeThread(current, [row('a1', { text: 'x' }), row('a2')], NONE)).toBe(current);
  });
});
```

Run: `npm test -w @termhub/web -- src/lib/chat-merge.test.ts`
Expected: FAIL.

- [ ] **Step 5: Write the merge**

`apps/web/src/lib/chat-merge.ts`: add the two predicates, the guard in `mergeMessage` (right after the `at === -1` line) and `mergeThread`:

```ts
const isAnswered = (m: ChatMessage): boolean => m.role === 'assistant' && (Boolean(m.text) || Boolean(m.error_code));
const isEmptyAnswer = (m: ChatMessage): boolean => m.role === 'assistant' && !m.text && !m.error_code;

  // in mergeMessage:
  // An answer never goes from final back to empty: the empty version is older, whatever brought it.
  if (isAnswered(list[at]) && isEmptyAnswer(msg)) return list as ChatMessage[];

/**
 * A re-read of the same conversation into the thread on screen (spec 2026-09-29 §5), what the phone's
 * `mergeThread` does: a row the screen holds as final keeps its version over the snapshot's empty one;
 * a row the screen saw removed is left out; a row the snapshot lacks goes, unless it is newer than the
 * snapshot's newest row (its `message` event landed while the read was in flight); every other row is
 * the snapshot's. The very same `current` back when nothing changed.
 */
export function mergeThread(current: readonly ChatMessage[], server: readonly ChatMessage[], removed: ReadonlySet<string>): ChatMessage[] {
  const listed = server.filter((m) => !removed.has(m.id));
  const ids = new Set(listed.map((m) => m.id));
  const newest = listed.reduce((max, m) => (m.created_at > max ? m.created_at : max), '');
  const byId = new Map(current.map((m) => [m.id, m]));
  const merged = listed.map((m) => {
    const old = byId.get(m.id);
    if (!old) return m;
    if (isAnswered(old) && isEmptyAnswer(m)) return old;
    return same(old, m) ? old : m;
  });
  const newer = current.filter((m) => !ids.has(m.id) && !removed.has(m.id) && m.created_at > newest);
  const next = [...merged, ...newer];
  return next.length === current.length && next.every((m, i) => m === current[i]) ? (current as ChatMessage[]) : next;
}
```

Run: `npm test -w @termhub/web -- src/lib/chat-merge.test.ts src/lib/chat-live.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing tests of the panel**

In `apps/web/src/components/chat/ChatPanel.test.tsx`, with the file's own helpers (`chatMock` answers `api.chat`, `streamMock` captures the `onReconnect` and `onEvent` the panel passes to `useChatStream`; the test about `pensando…` on every started answer shows how to push an event):

1. `a row the server lists as open shows "pensando…" on load`: `chatMock` answers a thread with an empty assistant row `a1` and `open_answer_ids: ['a1']`; expect `pensando…` with no event pushed.
2. `an empty row the server does not list shows as failed`: the same thread with `open_answer_ids: []`; expect no `pensando…`.
3. `a server that sends no open_answer_ids behaves as before`: the field absent; expect no `pensando…` and no crash.
4. `a row that finished while the read was in flight stays final`: first load with `a1` final is not needed; instead: load with `a1` empty and listed; push the final `message` of `a1` with text `pronto`; make the next `chatMock` answer the stale snapshot (`a1` empty, listed) and trigger `onReconnect`; expect `pronto` on screen and no `pensando…`.
5. `a removed row leaves the thread, and "Nova conversa" is enabled again`: load with `q1`, `a1` (empty, listed) and a newer `q2`, `a2` (empty, listed); push `{ type: 'message_removed', message_id: 'a1', conversation_id: 'c1' }`, then the final `message` of `a2`; expect one row less and the button `Nova conversa` enabled.
6. `"Nova conversa" is disabled while an older row is still open`: load with `a1` empty and listed followed by a final `a2`; expect the button disabled.
7. `a run that could not start re-reads the conversation and says so`: push `{ type: 'run_finished', message_id: null, ok: false, error_code: 'SETUP_FAILED', conversation_id: 'c1' }`; expect `chatMock` called again and the text `O concierge não conseguiu começar a resposta. Tente de novo.`.
8. `another conversation replaces the thread`: after "Nova conversa" (`resetMock` resolves, `chatMock` then answers conversation `c2` with an empty thread) no row of `c1` is on screen.
9. `a final message held before the panel knew its conversation reaches the thread`: make `chatMock` pending, push the final `message` of `a1` tagged `c1`, resolve `chatMock` with the stale snapshot (`a1` empty, listed); expect the final text on screen.

Run: `npm test -w @termhub/web -- src/components/chat/ChatPanel.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 7: Change the panel**

In `apps/web/src/components/chat/ChatPanel.tsx`:

1. `const { fold, version, push, seed, clear } = useChatLive();` must be declared before `load` (move the block up); add `const shown = useRef<string | null>(null);`.
2. `load`:

```ts
    const { conversation, messages, open_answer_ids, /* the rest as today */ } = projectId ? await api.chat(projectId) : await api.chat();
    // The same conversation: the snapshot merges into the thread, so a row that ended or was removed
    // while this read was in flight is not brought back. Another one (a reset, another project)
    // replaces the thread, and what was known about the old rows goes with it.
    const same = shown.current === conversation.id;
    shown.current = conversation.id;
    if (!same) clear();
    const removed = fold.removed();
    setMessages((prev) => (same ? mergeThread(prev, messages, removed) : messages));
    seed(open_answer_ids ?? []);
```

   with `seed`, `clear` and `fold` in the dependency list (all stable).
3. One handler for a conversation's own events, used by `onEvent` and by the replay of held events:

```ts
  /** One event of this conversation, live or held: the fold takes what is its business, the thread the rest. */
  const applyOwn = useCallback(
    (e: ChatEvent) => {
      push(e);
      if (e.type === 'message') setMessages((prev) => mergeMessage(prev, e.message));
      else if (e.type === 'message_removed') setMessages((prev) => (prev.some((m) => m.id === e.message_id) ? prev.filter((m) => m.id !== e.message_id) : prev));
      else if (e.type === 'run_finished' && e.message_id === null && !e.ok) {
        // The run could not even be attempted, and nobody awaits it any more: this is where it is said.
        setError(SETUP_FAILED_TEXT);
        void load().catch(() => undefined);
      }
    },
    [push, load],
  );
```

   with `const SETUP_FAILED_TEXT = 'O concierge não conseguiu começar a resposta. Tente de novo.';` at module level. In `onEvent`, the `push(e)` call and the `if (e.type === 'message')` branch are replaced by `applyOwn(e)` followed by the existing chain starting at `if (e.type === 'confirmation')`. In the layout effect that replays `early.current`, `push(e)` becomes `applyOwn(e)`, and its comment says why the thread is fed too.
4. `answering`:

```ts
  /** Whether an answer is being written right now: any row the thread lists, empty and started. With
   *  injected and queued messages the open row is not always the newest. */
  const answering = sending || messages.some((m) => m.role === 'assistant' && !m.text && !m.error_code && fold.get(m.id)?.started === true);
```

   `version` must stay in scope where `answering` is computed (it is what re-renders on a fold change).
5. `reset()` needs no change: the `load()` it calls finds another conversation id.

Run: `npm test -w @termhub/web -- src/components/chat src/lib src/pages && npm run typecheck -w @termhub/web`
Expected: PASS.

- [ ] **Step 8: Write the lesson**

`docs/lessons/2026-09-29-deleted-answer-row-stays-on-screen.md`, in the format of `docs/lessons/README.md`:

- symptom: `an answer bubble says "pensando…" for ever after a message typed while the concierge was running a tool, until the page is reloaded`
- tags: `[chat, web, mobile, events]`, evidence: `fixed` when the panel test of step 6 case 5 failed before the change, card `TER-416`.
- Cause: the server deleted the row and re-published the question, and its comments said screens re-read on that. No screen did: both merge by id and never remove.
- Fix: `message_removed`, and a merge of a re-read that drops what the server no longer has.
- Rule of thumb: a comment that says what another component does on an event is a claim to test in that component, not in the one that publishes.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src docs/lessons/2026-09-29-deleted-answer-row-stays-on-screen.md
git commit -m "Web: the chat shows what the server says is being answered" -m "A page opened in the middle of a run showed the answer as failed, a retried run looked failed, and a row the server deleted stayed as pensando for ever. The thread now merges a re-read instead of replacing it, so an older snapshot cannot bring a finished row back empty."
```

---

### Task 5: The phone follows the server's word

**Files:**
- Modify: `apps/mobile/src/services/api/contract/local.ts` (`chatResponse`)
- Modify: `apps/mobile/src/features/chat/model/live.ts`
- Modify: `apps/mobile/src/features/chat/model/events.ts`
- Modify: `apps/mobile/src/features/chat/model/copy.ts`
- Modify: `apps/mobile/src/features/chat/viewmodel/createChatStore.ts`
- Test: `apps/mobile/src/features/chat/model/live.test.ts`, `apps/mobile/src/features/chat/model/events.test.ts`, `apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts`, and the contract's test if `chatResponse` has one

**Interfaces:**
- Consumes: `chatEventSchema` with the two events (Task 1, through `@termhub/mobile-api`), `open_answer_ids` (Task 2).
- Produces: nothing other tasks use.

**Changed after the review of Task 4:** rule 3 of a re-read does not compare `created_at`. A row
the snapshot lacks is kept only when its `message` event reached the screen while that read was in
flight, and the rows a merge drops are closed in the fold. `mergeThread` takes the set of ids that
arrived during the read in place of the comparison. Where the snippets of this task compare
`created_at` with the newest row of the snapshot, use that set.

- [ ] **Step 1: The contract**

`apps/mobile/src/services/api/contract/local.ts`, in `chatResponse`, after `subagents`:

```ts
  /** The answer rows still to be answered (spec 2026-09-29): what the screen shows as "pensando…"
   * when it opens in the middle of a run. Defaulted: an older server never sends the field. */
  open_answer_ids: z.array(z.string()).default([]),
```

Every test fixture of a `chatResponse` that is built by hand and typed as `TChatResponse` gains `open_answer_ids: []`.

- [ ] **Step 2: Write the failing tests of the fold**

In `apps/mobile/src/features/chat/model/live.test.ts`, with the file's own event builders:

1. `run_started` marks the row started, and the same fold comes back the second time.
2. `seedLive` adds the listed ids, skips closed ones, and returns the very same fold when nothing is new.
3. A final `message` closes the row: `seedLive`, `run_started` and an empty `message` for that id all return the same fold.
4. `run_finished` with an id closes it; with `message_id: null` it returns the same fold.
5. `message_removed` closes the row, drops what streamed and adds the id to `removed`; for an id the fold never saw it still adds it.
6. `reset` keeps the started mark (already so; keep the existing test).
7. `pruneLive` closes the rows the thread shows finished.
8. `emptyFold()` has empty `closed` and `removed`.

Run: `npm test -w @termhub/mobile -- src/features/chat/model/live.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the fold**

`apps/mobile/src/features/chat/model/live.ts`:

```ts
export interface LiveFold {
  deltas: Map<string, string>;
  actions: Map<string, { tool: string }[]>;
  started: Set<string>;   // keep the existing comment
  /** Rows that had their final `message`, their `run_finished` or were removed: nothing opens them
   * again. A snapshot older than the event would otherwise bring the row back as being answered. */
  closed: Set<string>;
  /** Rows the server deleted: a snapshot that still lists one leaves it out. */
  removed: Set<string>;
}

export const emptyFold = (): LiveFold => ({ deltas: new Map(), actions: new Map(), started: new Set(), closed: new Set(), removed: new Set() });

const withAdded = (set: Set<string>, id: string): Set<string> => (set.has(id) ? set : new Set(set).add(id));

/** The row is open: started, unless it was closed. The very same fold when nothing changes. */
function open(fold: LiveFold, id: string): LiveFold {
  if (fold.closed.has(id) || fold.started.has(id)) return fold;
  return { ...fold, started: withAdded(fold.started, id) };
}

/** The row is over: what streamed for it goes, and nothing opens it again. */
function close(fold: LiveFold, id: string, removed: boolean): LiveFold {
  const dropped = drop(fold, id, false);
  const closed = withAdded(dropped.closed, id);
  const gone = removed ? withAdded(dropped.removed, id) : dropped.removed;
  if (dropped === fold && closed === fold.closed && gone === fold.removed) return fold;
  return { ...dropped, closed, removed: gone };
}

/** The rows the server lists as still to be answered (`open_answer_ids`). Add-only. */
export function seedLive(fold: LiveFold, ids: readonly string[]): LiveFold {
  return ids.reduce(open, fold);
}
```

`drop` must carry `closed` and `removed` through (spread the fold). In `applyLive`:

```ts
    case 'delta':   // and 'action': return `fold` unchanged when `fold.closed.has(e.message_id)`; otherwise as today, spreading the fold
    case 'run_started':
      return open(fold, e.message_id);
    case 'run_finished':
      return e.message_id === null ? fold : close(fold, e.message_id, false);
    case 'message_removed':
      return close(fold, e.message_id, true);
    case 'message': {
      const { message } = e;
      if (message.role !== 'assistant') return fold;
      if (!message.text && !message.error_code) return open(fold, message.id);
      return close(fold, message.id, false);
    }
```

`pruneLive` uses `close(f, m.id, false)` instead of `drop`.

Run: `npm test -w @termhub/mobile -- src/features/chat/model/live.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing tests of the thread**

In `apps/mobile/src/features/chat/model/events.test.ts`:

1. `mergeMessage` keeps a final row over an empty one (text, and error code), returning the same list.
2. `mergeThread(current, server, removed)` leaves out a removed row of the snapshot, and does not keep a removed row as "newer than the snapshot".
3. `applyEvent` with `message_removed` drops the row from `messages` and closes it in `live`; for a row the slice does not have it returns a slice whose `messages` is the same array.
4. `applyEvent` with `run_started` changes only `live`.

Every existing call of `mergeThread` in tests gains the third argument `new Set()`.

Run: `npm test -w @termhub/mobile -- src/features/chat/model/events.test.ts`
Expected: FAIL.

- [ ] **Step 5: Write the thread rules**

`apps/mobile/src/features/chat/model/events.ts`:

```ts
const isAnswered = (m: ChatMessage): boolean => m.role === 'assistant' && (Boolean(m.text) || Boolean(m.error_code));
const isEmptyAnswer = (m: ChatMessage): boolean => m.role === 'assistant' && !m.text && !m.error_code;

// in mergeMessage, right after `const old = list[i]!;`
  // An answer never goes from final back to empty: the empty version is older, whatever brought it.
  if (isAnswered(old) && isEmptyAnswer(msg)) return list;

export function mergeThread(current: ChatMessage[], server: ChatMessage[], removed: ReadonlySet<string>): ChatMessage[] {
  const listed = removed.size === 0 ? server : server.filter((m) => !removed.has(m.id));
  const ids = new Set(listed.map((m) => m.id));
  const newest = listed.reduce((max, m) => (m.created_at > max ? m.created_at : max), '');
  const kept = current.filter((m) => ids.has(m.id) || m.local !== undefined || (m.created_at > newest && !removed.has(m.id)));
  return listed.reduce(mergeMessage, kept.length === current.length ? current : kept);
}

// in applyEvent
    case 'run_started':
    case 'run_finished': {
      const live = applyLive(slice.live, e);
      return live === slice.live ? slice : { ...slice, live };
    }
    case 'message_removed': {
      const live = applyLive(slice.live, e);
      const messages = slice.messages.some((m) => m.id === e.message_id) ? slice.messages.filter((m) => m.id !== e.message_id) : slice.messages;
      return messages === slice.messages && live === slice.live ? slice : { ...slice, messages, live };
    }
```

Fix the comment of `mergeThread` ("the server's version wins" is no longer the whole rule) and the comment of `applyLive` that lists the events it ignores. If `applyEvent` already has a `run_finished` case or a default that covers it, merge with it rather than duplicating.

Run: `npm test -w @termhub/mobile -- src/features/chat/model && npm run typecheck -w @termhub/mobile`
Expected: PASS. The typecheck points at every caller of `mergeThread` and every hand-built `LiveFold`.

- [ ] **Step 6: Write the failing tests of the store**

In `apps/mobile/src/features/chat/viewmodel/createChatStore.test.ts`, with the file's own fake `api` and its way of delivering socket events:

1. `a refresh marks the rows the server lists as open`: `api.chat` answers an empty assistant row `a1` and `open_answer_ids: ['a1']`; after the refresh `getState().live.started.has('a1')` is true.
2. `a refresh of another conversation starts from an empty fold, then seeds`.
3. `a row that ended while the refresh was in flight stays final`: deliver the final `message` of `a1` while `api.chat` is pending, resolve it with the stale snapshot (`a1` empty, listed); the slot's row keeps its text and `live.started.has('a1')` is false.
4. `a removed row leaves the thread and a later snapshot does not bring it back`.
5. `a run that could not start refreshes the conversation and says so`: deliver `{ type: 'run_finished', message_id: null, ok: false, error_code: 'SETUP_FAILED', ... }` for the open conversation; `api.chat` is called again and the store's error line is `O concierge não conseguiu começar a resposta. Tente de novo.`. The same event tagged with another conversation changes nothing.
6. `run_finished` still flushes the storage (the existing test stays).

Run: `npm test -w @termhub/mobile -- src/features/chat/viewmodel/createChatStore.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 7: Change the store**

`apps/mobile/src/features/chat/model/copy.ts`: add `setupFailed: 'O concierge não conseguiu começar a resposta. Tente de novo.'` to `CHAT_MSG`.

`apps/mobile/src/features/chat/viewmodel/createChatStore.ts`:

1. `reread`: the `mergeThread` call passes `key === activeKey() ? get().live.removed : NO_IDS` (a module-level empty `Set<string>`), and the block that prunes the fold becomes

```ts
            if (key === activeKey()) {
              const live = seedLive(same ? pruneLive(get().live, res.messages) : emptyFold(), res.open_answer_ids);
              if (live !== get().live) set({ live });
            }
```

2. `onEvent`, after the slice was applied, next to the `run_finished` flush:

```ts
          // A run that could not even be attempted: nobody awaits it, so this is where it is said.
          // Only for the conversation on screen: `belongsTo` above already dropped the others.
          if (e.type === 'run_finished' && e.message_id === null && !e.ok) {
            const gen = generation;
            void reread(key).then(() => {
              if (gen === generation) set({ error: CHAT_MSG.setupFailed });
            });
          }
```

   Put the line where a failed send's line goes (read how `send` reports its failure; if it is the slot's `error`, set that one instead, after the refresh, which clears it).
3. If `live` is part of what `persist` stores (`partialize`), make sure `closed` and `removed` are serialised and revived like `started`, and that a state persisted by an older version, which lacks them, revives with empty sets.

Run: `npm test -w @termhub/mobile -- src/features/chat && npm run typecheck -w @termhub/mobile`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src
git commit -m "Mobile: the chat shows what the server says is being answered" -m "The same rules as the web: rows listed as open are shown as being answered, a row that ended or was removed is closed for good, and a run that could not start is said on the screen."
```

---

### Task 6: The roadmap says what was delivered

**Files:**
- Modify: `docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md` (Front 4)

- [ ] **Step 1: Update the Front 4 section**

Tick its items, name this plan and its spec, and record what changed against the roadmap: `ChatService.send` was kept; `message_removed` was added; the null `run_finished` is handled by both screens; a row alive in the other instance is not listed.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-09-29-chat-and-machine-agent-roadmap.md
git commit -m "Docs: front 4 of the roadmap, as delivered"
```
