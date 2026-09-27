# Suggestion cards: context from the Stop, none while background work runs (TER-203) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A suggestion card always shows the agent message it answers, never opens while the tab has background tasks running, and no longer claims the tab "está esperando sua resposta" — on the web and in the app.

**Architecture:** The Claude `Stop` interpreter counts running `background_tasks` (count only). The ingest path hands the `Stop`'s own `last_assistant_message` and that count to `scheduleTabSuggestion`, which skips (with a metadata log) on background work or a missing message, and otherwise passes the cleaned message to `checkTabSuggestion` as the row's `context` — the tab row's `state_text` is no longer read. Web and app change the open card's title, add a "Não precisa responder." hint and use a neutral border.

**Tech Stack:** Fastify + vitest in `@termhub/server`; React + Testing Library + vitest in `@termhub/web`; Expo/React Native + jest + RNTL in `@termhub/mobile`.

**Spec:** `docs/superpowers/specs/2026-09-26-suggestion-card-context-and-background-design.md` (read it first; §2 has the investigation, §3 the decisions). Builds on `2026-09-25-tab-suggestions-design.md` (TER-82) and `2026-09-26-tab-questions-hardening-design.md` (TER-83/TER-96).

**Board:** card TER-203 (epic TER-1 · Chat). One subtask per task below, created by the planning session; tick each as its task passes review. Task 7 belongs to Pedro.

## Global Constraints

- Code, comments, identifiers, commits, PR text, repo docs: **English**. **UI copy pt-BR, verbatim:** open title `«X» terminou — o Claude Code sugere:` / `Uma aba terminou — o Claude Code sugere:`; hint `Não precisa responder.`; closed titles unchanged `«X» sugere:` / `Uma aba sugere:`; field label unchanged `Sugestão do Claude Code (opcional — edite ou dispense)`; buttons unchanged **Enviar** / **Dispensar**.
- **Mobile parity in the same delivery**: web and `@termhub/mobile` get the same copy and behaviour.
- **Terminal content is never logged**: logs carry ids, reason codes and counts only (`reason`, `count`, `chars`, `contextChars`). `background_tasks` descriptions and commands never leave the interpreter.
- Skip log message: `'tab suggestion skipped'` with `{ tabId, reason: 'background', count }` or `{ tabId, reason: 'no_context' }`, level `info`.
- `SUGGESTION_DELAY_MS = 5000`, `STATE_TEXT_MAX = 2000`, `cleanContext` rules unchanged.
- No contract change (`payload: { text, context }`), no migration, no hook script change, **no `@termhub/agent` release**.
- **Node only through Docker.** CLAUDE.md documents `node:20`; if a step fails only on an engine check, rerun with `node:22` (CI's version) and say so. Helper used below, from the worktree root:
  `NODE() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c "$1"; }` — once: `NODE 'npm ci && npm run build:packages'`; after the session, `rm -rf .npm`.
- **Production is untouchable** (`termhub-*`, `proxy-*`, other `*-app-*`); everything this plan creates is named `th-*`. tmux only on an isolated socket (`-L th-…` / `-S $E2E/…`), never bare `tmux`; never write `~/.termhub/*` or `~/.claude/settings.json`.
- **No push, no merge, no deploy** from this plan. Commit subject imperative, ≤ 72 chars; body ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. A `Stop` whose `background_tasks` holds only `completed`/`failed`/`killed` entries (the last task just ended) must still open a card — Task 1 (`only completed` case) and Task 2 (`backgroundTasks: 0` opens).
2. A `Stop` without text arriving while an older suggestion check is pending must cancel it and open nothing (the older check would otherwise open with a stale message) — Task 2 ("a skipped Stop still cancels the pending check").
3. The tab row's `state_text` being overwritten in the 5 s window (idle reminder, another tool) must not change the stored context — Task 2 ("stores the Stop's message whatever the tab row says").
4. `background_tasks` in odd shapes (not an array, non-object entries, `status` not a string) must count as 0, never throw — Task 1 (`it.each`).
5. A command line inside `background_tasks` (it can hold secrets, e.g. `curl -H 'Authorization: …'`) must never reach the event meta or a log — Task 1 (`not.toContain`) and Task 2 (skip log check).

---

### Task 1: Interpreter counts a Claude `Stop`'s running background tasks

**Files:**
- Modify: `apps/server/src/monitor/state.ts` (the `Interpreted` interface, `case 'Stop'` in `interpretClaudeEvent`, a new exported helper next to `claudeSessionOf`)
- Test: `apps/server/src/monitor/state.test.ts`

**Interfaces:**
- Produces: `Interpreted.backgroundTasks?: number` (set only on a Claude `Stop`, only when > 0); `meta.background_tasks: number` on that event (only when > 0); `export function runningBackgroundTasks(v: unknown): number`.

- [ ] **Step 1: Write the failing tests** — append to `apps/server/src/monitor/state.test.ts`:

```ts
describe('claude Stop background tasks (spec 2026-09-26 TER-203 §4.1)', () => {
  const task = (status: unknown) => ({ id: 'b1', type: 'shell', status, description: 'Watch CI', command: "curl -H 'Authorization: Bearer s3cr3t' https://ci" });
  it.each([
    ['one running', [task('running')], 1],
    ['running and completed', [task('running'), task('completed'), task('running')], 2],
    ['only completed (the last task just ended)', [task('completed'), task('failed')], 0],
    ['empty', [], 0],
    ['absent (Claude Code without the field)', undefined, 0],
    ['not an array', 'running', 0],
    ['entries that are not objects, or a status that is not a string', ['running', null, task(1)], 0],
  ])('%s', (_label, background, count) => {
    const i = interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: 'Vigiando o CI.', ...(background === undefined ? {} : { background_tasks: background }) });
    expect(i?.text).toBe('Vigiando o CI.');
    expect(i?.backgroundTasks).toBe(count > 0 ? count : undefined);
    expect(i?.meta).toEqual(count > 0 ? { event: 'Stop', background_tasks: count } : { event: 'Stop' });
    expect(JSON.stringify(i)).not.toContain('s3cr3t');
    expect(JSON.stringify(i)).not.toContain('Watch CI');
  });

  it('only a Stop carries the count', () => {
    const background_tasks = [task('running')];
    expect(interpretHookEvent('claude', { hook_event_name: 'UserPromptSubmit', background_tasks })?.backgroundTasks).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'server_error', background_tasks })?.backgroundTasks).toBeUndefined();
  });

  it('runningBackgroundTasks never throws', () => {
    expect(runningBackgroundTasks(undefined)).toBe(0);
    expect(runningBackgroundTasks({ length: 3 })).toBe(0);
    expect(runningBackgroundTasks([{ status: 'running' }, { status: 'RUNNING' }])).toBe(1);
  });
});
```

Add `runningBackgroundTasks` to the file's import from `./state.js`.

- [ ] **Step 2: Run to see it fail**

Run: `NODE 'npm test -w @termhub/server -- src/monitor/state.test.ts'`
Expected: FAIL (`runningBackgroundTasks` is not exported; `backgroundTasks` undefined for the running cases).

- [ ] **Step 3: Implement** in `apps/server/src/monitor/state.ts`.

In `interface Interpreted`, after `keepsWaitText`:

```ts
  /**
   * Only on a Claude `Stop`, only when > 0: how many of its `background_tasks` still run (a `Monitor`, a
   * `run_in_background` shell). The tab is not blocked — the next task notification wakes it — so no suggestion
   * card opens for this Stop (spec 2026-09-26 TER-203 §3). The count is all that leaves the payload.
   */
  backgroundTasks?: number;
```

Next to `claudeSessionOf`:

```ts
/**
 * How many entries of a Claude `Stop`'s `background_tasks` have `status: "running"` (Claude Code 2.1.283 sends
 * `[{ id, type, status, description, command }]`). Anything else counts as 0. Descriptions and commands are the
 * person's and are never read.
 */
export function runningBackgroundTasks(v: unknown): number {
  return Array.isArray(v) ? v.filter((t) => isObj(t) && t.status === 'running').length : 0;
}
```

Replace `case 'Stop':` in `interpretClaudeEvent`:

```ts
    case 'Stop': {
      // A finished turn is the tool waiting for the person (same as Codex); the idle_prompt
      // notification only comes about a minute later. The last answer, when sent, is the question.
      const text = cap(str(ev.last_assistant_message));
      const background = runningBackgroundTasks(ev.background_tasks);
      if (background === 0) return { kind: 'waiting_input', text, meta: { event: name } };
      return { kind: 'waiting_input', text, meta: { event: name, background_tasks: background }, backgroundTasks: background };
    }
```

- [ ] **Step 4: Run to see it pass**

Run: `NODE 'npm test -w @termhub/server -- src/monitor/state.test.ts'`
Expected: PASS (the existing `toEqual` for a bare `Stop` still passes: no field when 0).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/monitor/state.ts apps/server/src/monitor/state.test.ts
git commit -m "Monitor: count a Claude Stop's running background tasks"
```

---

### Task 2: Suggestion check takes the Stop's message; skip on background work or no message

**Files:**
- Modify: `apps/server/src/chat/tab-suggestions.ts` (`scheduleTabSuggestion`, `checkTabSuggestion`, docstrings)
- Modify: `apps/server/src/monitor/ingest.ts` (the `scheduleTabSuggestion` call)
- Test: `apps/server/src/chat/tab-suggestions.test.ts`, `apps/server/src/monitor/ingest.test.ts`

**Interfaces:**
- Consumes: `Interpreted.backgroundTasks?: number` (Task 1).
- Produces: `export interface StopFacts { context: string | null; backgroundTasks: number }`; `scheduleTabSuggestion(repos, log, tabId: string, stop: StopFacts): void`; `checkTabSuggestion(repos, log, tabId: string, context: string, still?: () => boolean): Promise<void>`.

- [ ] **Step 1: Update the existing tests to the new signatures** in `apps/server/src/chat/tab-suggestions.test.ts`:
  - Below `const CONTEXT = …` add `const STOP = { context: CONTEXT, backgroundTasks: 0 };`.
  - Every `checkTabSuggestion(asRepos(<x>), <log>, 't1'` becomes `checkTabSuggestion(asRepos(<x>), <log>, 't1', CONTEXT` (the `() => false` case keeps its last argument after `CONTEXT`).
  - Every `scheduleTabSuggestion(asRepos(repos), log(), '<id>')` becomes `scheduleTabSuggestion(asRepos(repos), log(), '<id>', STOP)`.
  - Delete the `it.each` "stores no context when %s" in `describe('checkTabSuggestion — context and old agents')` (its three cases now never reach the check; they are covered in Step 2).

- [ ] **Step 2: Write the failing tests** — append to `apps/server/src/chat/tab-suggestions.test.ts`:

```ts
describe('the Stop decides (spec 2026-09-26 TER-203 §4.2)', () => {
  it("stores the Stop's message whatever the tab row says by then", async () => {
    const repos = fakeRepos({ tab: { ...tab, state_text: CLAUDE_IDLE_MESSAGE, state_tool: 'codex' } });
    await checkTabSuggestion(asRepos(repos), log(), 't1', CONTEXT);
    expect(repos.tabQuestions.open).toHaveBeenCalledWith(expect.objectContaining({ payload: { text: 'commit it', context: CONTEXT } }));
  });

  it('schedules with the cleaned message', async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', { context: ' Pronto.\u0007\n\nQuer o commit? ', backgroundTasks: 0 });
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS);
    await settle();
    expect(repos.tabQuestions.open).toHaveBeenCalledWith(expect.objectContaining({ payload: { text: 'commit it', context: 'Pronto.\n\nQuer o commit?' } }));
  });

  it('running background work: no timer, no capture, a reason in the log', async () => {
    fakeTimers();
    const repos = fakeRepos();
    const l = log();
    scheduleTabSuggestion(asRepos(repos), l, 't1', { context: CONTEXT, backgroundTasks: 2 });
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS * 2);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    expect(captureStyledScreen).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', reason: 'background', count: 2 }, 'tab suggestion skipped');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('commit');
  });

  it.each([
    ['no message (a Stop without last_assistant_message)', null],
    ['a blank message', ' \n​ '],
    ["Claude's idle reminder", CLAUDE_IDLE_MESSAGE],
  ])('%s: no timer, reason no_context', async (_label, context) => {
    fakeTimers();
    const repos = fakeRepos();
    const l = log();
    scheduleTabSuggestion(asRepos(repos), l, 't1', { context, backgroundTasks: 0 });
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS * 2);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', reason: 'no_context' }, 'tab suggestion skipped');
  });

  it('a skipped Stop still cancels the pending check of an earlier one', async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1', STOP);
    await vi.advanceTimersByTimeAsync(1000);
    scheduleTabSuggestion(asRepos(repos), log(), 't1', { context: null, backgroundTasks: 0 });
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS * 2);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });
});
```

In `apps/server/src/monitor/ingest.test.ts`, `describe('ingestHookEvent — suggestions')`: change the first test's expectation to
`expect(schedule).toHaveBeenCalledWith(r, log, 't1', { context: null, backgroundTasks: 0 });` and add:

```ts
  it("hands the Stop's own message and running background count to the check", async () => {
    schedule.mockClear();
    const { r } = repos(tab({ state: 'working' }));
    const event = { hook_event_name: 'Stop', last_assistant_message: 'Vigiando o CI.', background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] };
    await ingestHookEvent(r, log, { machineId: 'm1', tool: 'claude', session: 'th-t1', event });
    expect(schedule).toHaveBeenCalledWith(r, log, 't1', { context: 'Vigiando o CI.', backgroundTasks: 1 });
  });
```

- [ ] **Step 3: Run to see them fail**

Run: `NODE 'npm test -w @termhub/server -- src/chat/tab-suggestions.test.ts src/monitor/ingest.test.ts'`
Expected: FAIL (skip logs missing; context comes from `state_text`; the ingest call has three arguments).

- [ ] **Step 4: Implement** in `apps/server/src/chat/tab-suggestions.ts`.

Above `checkTabSuggestion`:

```ts
/** What the Claude `Stop` that schedules a check says about itself (spec 2026-09-26 TER-203 §4.2). */
export interface StopFacts {
  /** Its `last_assistant_message`, as interpreted (null when it sent none). */
  context: string | null;
  /** How many of its `background_tasks` still run. */
  backgroundTasks: number;
}
```

Replace `checkTabSuggestion`'s docstring and signature, and drop the `state_text` read:

```ts
/**
 * The delayed half of a Claude `Stop` (spec §6.1): when the tab still waits for input and its prompt
 * shows a suggestion, a row opens in the project owner's most recently active conversation — the same
 * owner rule as a question — and the card reaches every screen showing it. `context` is that `Stop`'s own
 * message, already cleaned by `scheduleTabSuggestion` (spec 2026-09-26 TER-203 §4.2): the tab row is not
 * read for it, since anything that reached the row in between would be the wrong message. An agent older
 * than 0.5.2 cannot keep attributes and is not asked. `still` is false once another hook event of the tab
 * arrived (the screen moved on). Never throws; logs ids and counts only.
 */
export async function checkTabSuggestion(repos: Repositories, log: Log, tabId: string, context: string, still: () => boolean = () => true): Promise<void> {
```

and delete the line `const context = tab.state_tool === 'claude' ? cleanContext(tab.state_text) : null;` (the `open` call and the `opened` log keep using `context`; `contextChars: context.length`).

Replace `scheduleTabSuggestion`:

```ts
/**
 * After a Claude `Stop`: fire-and-forget, never delays the hook POST. A second Stop restarts the wait —
 * and a Stop that opens nothing still cancels the previous one's check. No card for a Stop whose tab has
 * background work running (it resumes by itself on the next task notification) or that carries no message
 * (a card could not say what it answers) — spec 2026-09-26 TER-203 §3.
 */
export function scheduleTabSuggestion(repos: Repositories, log: Log, tabId: string, stop: StopFacts): void {
  cancelTabSuggestion(tabId);
  if (stop.backgroundTasks > 0) {
    log.info({ tabId, reason: 'background', count: stop.backgroundTasks }, 'tab suggestion skipped');
    return;
  }
  const context = cleanContext(stop.context);
  if (context === null) {
    log.info({ tabId, reason: 'no_context' }, 'tab suggestion skipped');
    return;
  }
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    const still = () => pending.get(tabId) === timer;
    void checkTabSuggestion(repos, log, tabId, context, still).finally(() => {
      if (still()) pending.delete(tabId);
    });
  }, SUGGESTION_DELAY_MS);
  timer.unref?.();
  pending.set(tabId, timer);
}
```

Update `CLAUDE_IDLE_MESSAGE`'s comment to: `/** Claude Code's \`Notification idle_prompt\` text: never a context (defensive since TER-203 — the context now comes from the Stop). */`.

In `apps/server/src/monitor/ingest.ts`, replace the scheduling line:

```ts
  // Claude Code draws its suggested next prompt shortly after the turn ends: look in a few seconds, with the
  // Stop's own message and background count (spec 2026-09-26 TER-203 §4.2).
  if (input.tool === 'claude' && interpreted.meta.event === 'Stop') scheduleTabSuggestion(repos, log, updated.id, { context: interpreted.text, backgroundTasks: interpreted.backgroundTasks ?? 0 });
```

- [ ] **Step 5: Run to see them pass, then the server typecheck**

Run: `NODE 'npm test -w @termhub/server -- src/chat/tab-suggestions.test.ts src/monitor/ingest.test.ts && npm run typecheck -w @termhub/server'`
Expected: PASS, typecheck clean (no other caller of `scheduleTabSuggestion` / `checkTabSuggestion`: confirm with `git grep -n "scheduleTabSuggestion\|checkTabSuggestion" apps/server/src`).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/chat/tab-suggestions.ts apps/server/src/chat/tab-suggestions.test.ts apps/server/src/monitor/ingest.ts apps/server/src/monitor/ingest.test.ts
git commit -m "Tab suggestions: use the Stop's message, skip on background work"
```

---

### Task 3: Web card no longer says the tab is waiting for an answer

**Files:**
- Modify: `apps/web/src/components/chat/tab-suggestion-text.ts` (`suggestionTitle`, new `SUGGESTION_HINT`)
- Modify: `apps/web/src/components/chat/TabSuggestionCard.tsx` (hint, border)
- Test: `apps/web/src/components/chat/tab-suggestion-text.test.ts`, `TabSuggestionCard.test.tsx`, `ChatPanel.test.tsx`

**Interfaces:**
- Produces: `export const SUGGESTION_HINT = 'Não precisa responder.'`; `suggestionTitle` open → `«X» terminou — o Claude Code sugere:`.

- [ ] **Step 1: Update and add tests.**
  - `tab-suggestion-text.test.ts`, `describe('suggestionTitle')`: rename the test to `'offers the suggestion while open (it asks nothing), and says what the tab suggested once closed'` and change the two open expectations to `'«api» terminou — o Claude Code sugere:'` and `'Uma aba terminou — o Claude Code sugere:'`.
  - `TabSuggestionCard.test.tsx`: replace `'«api» está esperando sua resposta'` with `'«api» terminou — o Claude Code sugere:'` and `'Uma aba está esperando sua resposta'` with `'Uma aba terminou — o Claude Code sugere:'` (test titles too), then append:

```tsx
it('says an open suggestion needs no answer; a closed card does not', () => {
  const { rerender } = render(<TabSuggestionCard suggestion={open()} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('Não precisa responder.')).toBeInTheDocument();
  rerender(<TabSuggestionCard suggestion={open({ id: 's2', status: 'dismissed' })} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.queryByText('Não precisa responder.')).not.toBeInTheDocument();
});
```

  - `ChatPanel.test.tsx`: replace the three `'«api» está esperando sua resposta'` / `'«web» está esperando sua resposta'` with `'«api» terminou — o Claude Code sugere:'` / `'«web» terminou — o Claude Code sugere:'`.

- [ ] **Step 2: Run to see them fail**

Run: `NODE 'npm test -w @termhub/web -- src/components/chat/tab-suggestion-text.test.ts src/components/chat/TabSuggestionCard.test.tsx src/components/chat/ChatPanel.test.tsx'`
Expected: FAIL on the titles and the hint.

- [ ] **Step 3: Implement.** In `tab-suggestion-text.ts` replace `suggestionTitle` and add the hint:

```ts
/**
 * While open the card offers Claude Code's suggestion for a tab that finished its turn — it asks nothing (spec
 * 2026-09-26 TER-203 §5); once closed it says what the tab had suggested. Keep in step with the app's copy.
 */
export const suggestionTitle = (s: TabSuggestion): string => {
  if (s.status === 'open') return s.tab_name ? `«${s.tab_name}» terminou — o Claude Code sugere:` : 'Uma aba terminou — o Claude Code sugere:';
  return s.tab_name ? `«${s.tab_name}» sugere:` : 'Uma aba sugere:';
};

/** Under an open card's title: a suggestion never needs an answer (spec 2026-09-26 TER-203 §5). */
export const SUGGESTION_HINT = 'Não precisa responder.';
```

In `TabSuggestionCard.tsx`: import `SUGGESTION_HINT`; the `<li>` class becomes `"rounded-xl border border-line bg-bg-2 px-4 py-3 text-sm"`; right after the title paragraph add
`{open && <p className="text-xs text-fg-dim">{SUGGESTION_HINT}</p>}`; update the component docstring's first line to "Claude Code's dimmed next prompt in a tab that finished its turn — an offer, not a question (spec 2026-09-26 TER-203 §5) —".

- [ ] **Step 4: Run to see them pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/tab-suggestion-text.ts apps/web/src/components/chat/TabSuggestionCard.tsx apps/web/src/components/chat/tab-suggestion-text.test.ts apps/web/src/components/chat/TabSuggestionCard.test.tsx apps/web/src/components/chat/ChatPanel.test.tsx
git commit -m "Web chat: a suggestion card offers, it does not ask for an answer"
```

---

### Task 4: App card, same copy

**Files:**
- Modify: `apps/mobile/src/features/chat/model/tab-suggestion-text.ts` (`suggestionTitle`, new `SUGGESTION_HINT`)
- Modify: `apps/mobile/src/features/chat/view/tab-suggestion-card.tsx` (hint, border)
- Test: `apps/mobile/src/features/chat/model/tab-suggestion-text.test.ts`, `apps/mobile/src/features/chat/view/conversation-screen.test.tsx`

**Interfaces:**
- Produces: the same `SUGGESTION_HINT` and `suggestionTitle` strings as Task 3 (the file header says "keep the two in step").

- [ ] **Step 1: Update and add tests.**
  - `tab-suggestion-text.test.ts`: the same title changes as Task 3 Step 1 (both open expectations and the test name).
  - `conversation-screen.test.tsx`: replace `'«api» está esperando sua resposta'` with `'«api» terminou — o Claude Code sugere:'`; right after that `findByText` line add `expect(screen.getByText('Não precisa responder.')).toBeTruthy();`. Any other occurrence of the old title in the file (`git grep -n "esperando sua resposta" apps/mobile/src`) moves the same way.

- [ ] **Step 2: Run to see them fail**

Run: `NODE 'npm test -w @termhub/mobile -- src/features/chat/model/tab-suggestion-text.test.ts src/features/chat/view/conversation-screen.test.tsx'`
Expected: FAIL on the title and the hint.

- [ ] **Step 3: Implement.** In `model/tab-suggestion-text.ts`, the same `suggestionTitle` body and `SUGGESTION_HINT` export as Task 3 Step 3 (docstring: "Keep in step with the web's copy."). In `view/tab-suggestion-card.tsx`: import `SUGGESTION_HINT`; the card `View` class becomes `"gap-3 rounded-2xl border border-app-border bg-app-surface2 p-4"`; right after the title `AppText` add
`{open ? <AppText variant="muted">{SUGGESTION_HINT}</AppText> : null}`; update the docstring like the web's.

- [ ] **Step 4: Run to see them pass, then the app typecheck**

Run: `NODE 'npm test -w @termhub/mobile -- src/features/chat/model/tab-suggestion-text.test.ts src/features/chat/view/conversation-screen.test.tsx && npm run typecheck -w @termhub/mobile'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/chat/model/tab-suggestion-text.ts apps/mobile/src/features/chat/view/tab-suggestion-card.tsx apps/mobile/src/features/chat/model/tab-suggestion-text.test.ts apps/mobile/src/features/chat/view/conversation-screen.test.tsx
git commit -m "App chat: a suggestion card offers, it does not ask for an answer"
```

---

### Task 5: Live test with a real Claude Code (isolated tmux, dev server, throwaway Postgres)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-suggestion-card-context-and-background-design.md` (new §10 "Live test results")
- Scratch only (never committed): everything under `$E2E`.

**Interfaces:**
- Consumes: Tasks 1–2 in the worktree.
- Produces: evidence that a real `Stop` yields a card whose `context` is that `Stop`'s message, that a `Stop` with a running `Monitor` yields no card (`reason: 'background'`), that a textless `Stop` yields none (`no_context`), and that logs carry no text.

**Safety:** every tmux call is `TB` (the dev server's isolated socket below). The only container is `th-e2e203-db`. The Claude sessions also load your user settings, whose real termhub hook posts to production with an unknown session name: production answers `202 unknown_session` and stores nothing. `npx tsx` runs on the host (Node 24 is on jarvis); if the dev server fails with a `node-pty` ABI error, run `npm rebuild node-pty` on the host once. `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` makes Claude Code draw suggestions even where they are paused (spec §2.2).

- [ ] **Step 1: Hook script, database, seed.** From the worktree root:

```bash
export WT=$PWD E2E=/tmp/claude-$(id -u)/th-e2e203 && rm -rf "$E2E" && mkdir -p "$E2E/work" "$E2E/home/.termhub/bin"
NODE 'npm run build -w @termhub/machine-ops'
node -e "import('$WT/packages/machine-ops/dist/index.js').then((m) => require('node:fs').writeFileSync('$E2E/home/.termhub/bin/termhub-hook', m.HOOK_SCRIPT, { mode: 0o755 }))"
docker run -d --name th-e2e203-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termhub -p 127.0.0.1:55203:5432 postgres:16-alpine
export DB=postgresql://postgres:postgres@127.0.0.1:55203/termhub
until docker exec th-e2e203-db pg_isready -U postgres -d termhub >/dev/null 2>&1; do sleep 1; done
(cd apps/server && DATABASE_URL=$DB npx prisma migrate deploy)
DATABASE_URL=$DB npx tsx apps/server/src/cli/create-user.ts --email e2e@test.local --name E2E --password e2e-pass-123
cat > "$E2E/seed.ts" <<'TS'
const wt = process.env.WT!;
const { closePrisma, getPrisma } = await import(`${wt}/apps/server/src/db/prisma.ts`);
const { createRepositories } = await import(`${wt}/apps/server/src/db/repositories/index.ts`);
const { newHookToken } = await import(`${wt}/apps/server/src/monitor/token.ts`);
const repos = createRepositories(getPrisma());
const user = (await repos.users.findByEmail('e2e@test.local'))!;
const machine = await repos.machines.create({ name: 'th-e2e203', type: 'local', owner_id: user.id });
const project = await repos.projects.create({ owner_id: user.id, key: 'EZT', name: 'e2e203' });
await repos.projectMachines.link({ project_id: project.id, machine_id: machine.id, cwd: process.env.E2E_WORK! });
const tab = await repos.tabs.create(project.id, machine.id, 'e2e');
const { token, hash } = newHookToken();
await repos.machineHooks.upsert(machine.id, hash);
console.log(JSON.stringify({ project_id: project.id, tab_id: tab.id, session: tab.tmux_session, token }));
await closePrisma();
TS
SEED=$(DATABASE_URL=$DB E2E_WORK="$E2E/work" npx tsx "$E2E/seed.ts" | tail -1); echo "$SEED"
J() { echo "$SEED" | node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }
PROJECT=$(J project_id); TAB=$(J tab_id); SESSION=$(J session); TOKEN=$(J token)
printf "TERMHUB_HOOK_URL='http://127.0.0.1:3203/api/hooks/events'\nTERMHUB_HOOK_TOKEN='%s'\n" "$TOKEN" > "$E2E/home/.termhub/hook.env"
HOOK="env HOME=$E2E/home $E2E/home/.termhub/bin/termhub-hook claude"
node -e "
const h = { type: 'command', command: process.argv[1], timeout: 10 };
const ev = ['SessionStart','UserPromptSubmit','PreToolUse','PermissionRequest','Notification','Stop','StopFailure','SessionEnd'];
const hooks = Object.fromEntries(ev.map((e) => [e, [{ ...(e === 'PreToolUse' || e === 'PermissionRequest' ? { matcher: '*' } : {}), hooks: [h] }]]));
require('fs').writeFileSync(process.argv[2], JSON.stringify({ hooks }));" "$HOOK" "$E2E/settings.json"
```

If `create-user.ts`, `repos.projects.create` or `repos.tabs.create` changed signature since TER-83, adapt the seed to the current one (`git grep -n "async create" apps/server/src/db/repositories/{projects,tabs}.ts`).

- [ ] **Step 2: Dev server and the tab's Claude.**

```bash
mkdir -p "$E2E/tmux" && chmod 700 "$E2E/tmux"
(cd apps/server && env -u TMUX TMUX_TMPDIR="$E2E/tmux" DATABASE_URL=$DB AUTH_MODE=disabled PORT=3203 HOST=127.0.0.1 PUBLIC_URL=http://127.0.0.1:3203 npx tsx src/index.ts > "$E2E/server.log" 2>&1 & echo $! > "$E2E/server.pid")
until curl -s http://127.0.0.1:3203/api/health | grep -q ok; do sleep 1; done
TB() { env -u TMUX tmux -S "$E2E/tmux/tmux-$(id -u)/default" "$@"; }
TB new-session -d -s "$SESSION" -x 160 -y 50 -c "$E2E/work" "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1 claude --settings $E2E/settings.json"
sleep 6; TB capture-pane -p -t "$SESSION" | tail -12   # folder trust prompt? select "Yes, I trust this folder":
TB send-keys -t "$SESSION" Up; sleep 0.3; TB send-keys -t "$SESSION" Enter; sleep 5
curl -s "http://127.0.0.1:3203/api/chat?project=$PROJECT" > /dev/null   # creates the project's conversation
sayB() { TB send-keys -t "$SESSION" -l -- "$1"; sleep 0.3; TB send-keys -t "$SESSION" Enter; }
sugg() { curl -s "http://127.0.0.1:3203/api/chat?project=$PROJECT" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).tab_suggestions.map(({ id, status, payload }) => ({ id, status, text: payload.text, context: payload.context })), null, 1)'; }
lastStop() { docker exec th-e2e203-db psql -U postgres -d termhub -Atc "select coalesce(text,'<null>') || ' | ' || meta::text from tab_events where tab_id = '$TAB' and meta->>'event' = 'Stop' order by created_at desc limit 1"; }
hookPost() { curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3203/api/hooks/events -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$1"; }
```

- [ ] **Step 3: A normal turn → a card with that Stop's message.** `sayB 'Create a file notes.txt with the line hello. End your answer with a short question asking whether you should commit it.'`; wait ~25 s. Expect:
  - `TB capture-pane -p -e -t "$SESSION" | grep -a '❯' | tail -1 | cat -v` shows `ESC[2m…ESC[0m` after `❯` (a drawn suggestion).
  - `sugg` → one `open` card; its `text` is the dimmed suggestion; its `context` equals the text part of `lastStop` (the Stop's message ending with the question).
  - `grep '"tab suggestion opened"' "$E2E/server.log"` → `contextChars` > 0.

- [ ] **Step 4: A running Monitor → no card.** `sayB 'Use the Monitor tool to watch this command: sleep 45; echo CI passed. End this turn saying in one sentence that you are watching CI.'`; wait ~15 s. Expect:
  - `lastStop` → meta contains `"background_tasks": 1`.
  - `sugg` → the Step 3 card is now closed (`answered_in_tab`) and no new `open` card exists, even if the prompt shows a dimmed suggestion.
  - `grep '"tab suggestion skipped"' "$E2E/server.log" | tail -1` → `"reason":"background","count":1`.
  Wait ~50 s more (the task ends, Claude Code runs a `<task-notification>` turn): `lastStop` has no `background_tasks`; if the prompt shows a dimmed suggestion, `sugg` has a new `open` card whose `context` is that final message; if Claude Code drew none, `server.log` shows no skip for that Stop and there is no card (both fine; note which).

- [ ] **Step 5: A Stop without a message → no card.** With a suggestion on screen (repeat Step 3's prompt with `todo.txt` if needed and dismiss its card: `curl -s -X POST http://127.0.0.1:3203/api/chat/tab-suggestions/<id>/dismiss`), post `hookPost "{\"tool\":\"claude\",\"session\":\"$SESSION\",\"event\":{\"hook_event_name\":\"Stop\"}}"` → `200`. Wait 7 s. Expect no new `open` card and `grep '"tab suggestion skipped"' "$E2E/server.log" | tail -1` → `"reason":"no_context"`.

- [ ] **Step 6: Nothing leaked.** `grep -c -e 'notes.txt' -e 'commit' -e 'CI passed' -e 'Monitor tool' -e 'sleep 45' "$E2E/server.log"` → `0`.

- [ ] **Step 7: Tear down, record, commit.** `kill $(cat "$E2E/server.pid")`; `TB kill-server`; `docker rm -f th-e2e203-db`; `rm -rf "$E2E"`. Add to the spec a `## 10. Live test results (<date>, Claude Code <version>)` section with one line per step (observed counts and reasons, no message text). Then:

```bash
git add docs/superpowers/specs/2026-09-26-suggestion-card-context-and-background-design.md
git commit -m "Spec: record the TER-203 live test with a real Claude Code"
```

---

### Task 6: Full verification

**Files:** none (a failing check sends the fix back to the task that owns the file).

- [ ] **Step 1: Every suite, typecheck and build touched by this plan.**

```bash
NODE 'npm run build:packages && npm test -w @termhub/server'
NODE 'npm run build:city -w @termhub/web && npm test -w @termhub/web'
NODE 'npm run typecheck -w @termhub/mobile && npm test -w @termhub/mobile'
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 \
  sh -c 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
rm -rf .npm
git grep -n "está esperando sua resposta" apps/web/src apps/mobile/src   # prints nothing
git status --short                                                      # clean
```

Expected: every suite passes, the typechecks and builds pass, the old title is gone from both clients.

---

### Task 7 (Pedro): Confirm the reported cause from production and the app build

Not code; belongs to the user (the implementing session may not read production).

- [ ] **Step 1:** On jarvis, run the two log reads in spec §8 for tab `bimdrmpzvvmu` (active color, and the stopped color for older lines). Note, per suggestion opened, `contextChars`, and per `Stop`, `textLen`.
- [ ] **Step 2:** On the iPhone, confirm the installed build is ≥ 0.2.0 (TestFlight shows it; TER-181 tests it). A build < 0.2.0 explains a context-less card by itself.
- [ ] **Step 3:** Add the findings to the TER-203 card. After this plan merges, the app copy (Task 4) reaches phones only with the next TestFlight build: add it to the next TER-104-style release.

---

## Self-review (writing-plans checklist)

**Spec coverage.** §4.1 → Task 1; §4.2 → Task 2 (context from the Stop, skip reasons, logs, `state_text` no longer read); §4.3 → no change (Task 2 keeps `payload: { text, context }`); §5 → Tasks 3 and 4 (title, hint, border, tests); §6 unit tests → Tasks 1–4, live test → Task 5, verification → Task 6; §7 risks → recorded, Task 7 Step 3 for the app build; §8 evidence → Task 7; §9 out of scope → untouched.

**Placeholders:** none; Task 5's `<id>` and `<date>`/`<version>` are values read during the run.

**Type consistency:** `Interpreted.backgroundTasks?: number` and `runningBackgroundTasks(v: unknown): number` (Task 1) → `ingest.ts` passes `interpreted.backgroundTasks ?? 0` (Task 2); `StopFacts { context: string | null; backgroundTasks: number }`, `scheduleTabSuggestion(repos, log, tabId, stop)`, `checkTabSuggestion(repos, log, tabId, context: string, still?)` (Task 2) match every call in Tasks 2 and 5; `SUGGESTION_HINT`, `suggestionTitle` identical strings in Tasks 3 and 4.

**Review Focus:** 1 → Task 1 (`only completed`) and Task 2 (`STOP` with `backgroundTasks: 0` opens); 2 → Task 2 ("a skipped Stop still cancels…"); 3 → Task 2 ("stores the Stop's message whatever the tab row says"); 4 → Task 1 (`it.each` shapes, `runningBackgroundTasks never throws`); 5 → Task 1 (`not.toContain('s3cr3t')`) and Task 2 (skip log `not.toContain`).
