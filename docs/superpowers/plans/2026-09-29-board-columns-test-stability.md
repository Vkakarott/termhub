# Stable BoardColumnsSettings test (TER-373) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `BoardColumnsSettings` tests stop failing `check` by timeout under load, and a wait that is really too slow reports its own error instead of a generic test timeout.

**Architecture:** The test that fails chains three actions and four waits inside one 5 s budget, and every test of the file ends while the component is still reloading. It is split into one test per action, every test waits for the reload to land, and the whole-test timeout is set explicitly above testing-library's wait timeout. The component does not change.

**Tech Stack:** TypeScript, React 19, vitest 3, @testing-library/react 16, jsdom (`@termhub/web`).

**Spec:** `docs/superpowers/specs/2026-09-29-chat-and-machine-agent-roadmap-design.md` (section 5, Front 2).

## Global Constraints

- Work only inside the worktree `/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap`, branch `fix/ter-373-board-columns-test`. Never `cd` to `/home/pedrogoiania/termhub`.
- This host shares Docker with production. Never stop, remove, kill or prune a container. Every container you start has a fixed name that begins with `th-` (for example `th-f2-red`) and runs with `--rm`. Do not build the name with `$RANDOM`.
- Run git as plain, separate commands: one git command per shell call, no `&&`, no `;`, no pipes.
- Docker only, Node 22. `D <name> '<cmd>'` below means:
  ```bash
  docker run --rm --name "<name>" -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -v "/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap:/w" -w /w node:22 sh -c '<cmd>'
  ```
  Dependencies are installed. After each run: `rm -rf /home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap/.npm`.
- Vitest file paths are relative to the workspace: `npm test -w @termhub/web -- src/components/BoardColumnsSettings.test.tsx`.
- Code, comments and commit messages in English. UI copy stays in Portuguese (the labels the tests look for do not change).
- The component `apps/web/src/components/BoardColumnsSettings.tsx` is not changed.
- The fix is not "a bigger timeout" alone: the split and the wait for the reload are the fix; the explicit `testTimeout` only puts the two timeouts in the right order.
- Commit subject: imperative, at most 72 characters. The commit body ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/components/BoardColumnsSettings.test.tsx` | The tests of the block: one action per test, each waits for the reload |
| `apps/web/src/test-setup.ts` | testing-library's wait timeout, with the reason and its relation to `testTimeout` |
| `apps/web/vite.config.ts` | vitest's `testTimeout`, explicit |

---

### Task 1: One action per test, each waiting for the reload

**Files:**
- Modify: `apps/web/src/components/BoardColumnsSettings.test.tsx`
- Modify: `apps/web/src/test-setup.ts`
- Modify: `apps/web/vite.config.ts` (the `test` key, last line of the config)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other code uses.

Context. In the component, every change calls `run(action)`: it awaits the API call, then `load()`, which calls `api.tasks.list` again and sets three states. The mock of `api.tasks.list` always answers the same four columns, so after a reload the screen is back to `A fazer`, `Fazendo`, `QA`, `Feito`. `mocks.list` is called once by the first render and once more by each action.

- [ ] **Step 1: Measure before changing anything**

Run the file ten times and keep the durations:

```
D th-f2-before 'cd apps/web && for i in 1 2 3 4 5 6 7 8 9 10; do npx vitest run src/components/BoardColumnsSettings.test.tsx 2>&1 | grep -E "Tests|Duration|FAIL|✓|×"; done'
```

Expected: ten passing runs (the flake needs CI's load to show). Write down, from one of the runs, the time vitest prints next to `renames on blur, changes a category and moves a column`. It is the number to beat.

- [ ] **Step 2: Rewrite the test file**

Replace the import of `@testing-library/react`:

```tsx
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
```

Add right after the `afterEach` block:

```tsx
/**
 * Every change reloads the block: the component calls the API, then lists the columns again and sets
 * its state. A test that ends on the API call leaves that reload for after `cleanup()`, and one that
 * goes on to the next action races it. `calls` is how many times the list has been asked for by then:
 * one for the first render, one more for each action.
 */
const reloaded = async (calls = 2) => {
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls));
  await act(async () => {}); // the reload's own setState lands inside act
};
```

Replace the test `'renames on blur, changes a category and moves a column'` with these three:

```tsx
  it('renames on blur', async () => {
    render(<BoardColumnsSettings project={project} />);
    const qa = await screen.findByDisplayValue('QA');
    fireEvent.change(qa, { target: { value: 'Em revisão' } });
    fireEvent.blur(qa);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('c4', { name: 'Em revisão' }));
    await reloaded();
  });

  it('does not rename when the name did not change', async () => {
    render(<BoardColumnsSettings project={project} />);
    const qa = await screen.findByDisplayValue('QA');
    fireEvent.blur(qa);
    await act(async () => {});
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('changes a category', async () => {
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.change(screen.getByLabelText('Tipo da coluna Fazendo'), { target: { value: 'todo' } });
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('c2', { category: 'todo' }));
    await reloaded();
  });

  it('moves a column', async () => {
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.click(screen.getByRole('button', { name: 'Subir QA' }));
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith('c4', 1));
    await reloaded();
  });
```

About `'does not rename when the name did not change'`: read `ColumnRow` in `apps/web/src/components/BoardColumnsSettings.tsx` (its `commit` function, called by `onBlur`) before keeping this test. If `commit` calls `onRename` even when the name is the same, the component renames on every blur, this test fails, and that is a finding about the component, which this plan does not change: remove this one test and say so in your report, with the lines of `commit` you read.

In `'says how many cards move and where before deleting'`, add as the last line of the test:

```tsx
    await reloaded();
```

In `'adds a column and sets the agent column'`, add `await reloaded();` right after the `waitFor` that checks `mocks.create`, and `await reloaded(3);` as the last line of the test (the second action of the same test).

In `'shows the server refusal'`, add as the last line of the test:

```tsx
    await reloaded();
```

- [ ] **Step 3: Run the file**

Run: `D th-f2-file 'npm test -w @termhub/web -- src/components/BoardColumnsSettings.test.tsx'`
Expected: every test passes, 0 failed, and no warning that a state update was not wrapped in `act(...)`.

If `reloaded()` times out in a test, the action of that test did not reload the block: read `run` in the component and the mock it awaits, and report what you found instead of raising a timeout.

- [ ] **Step 4: Put the two timeouts in order**

In `apps/web/vite.config.ts`, replace the comment above `test:` and the `test:` line:

```ts
  // Tests: the environment stays per file (`// @vitest-environment jsdom` on the screen tests).
  // `testTimeout` is explicit because it has to stay above testing-library's `asyncUtilTimeout`
  // (src/test-setup.ts): with the two equal, a wait that was only slow ended the whole test with
  // "Test timed out", and the message that says which wait and what the screen held was lost.
  test: { setupFiles: ['./src/test-setup.ts'], testTimeout: 15_000 },
```

In `apps/web/src/test-setup.ts`, replace the comment (keep the `import` and the `configure` call as they are):

```ts
// testing-library's default `waitFor`/`findBy*` timeout is 1 s. On the GitHub runner, with the
// whole suite in parallel workers, a screen that renders in ~50 ms here takes longer than that
// often enough to fail a run (BoardColumnsSettings "renames on blur" timed out on main once).
// 5 s changes nothing for a passing test — waitFor resolves as soon as the assertion holds —
// and only stops a slow worker from being read as a bug.
//
// It must stay below vitest's `testTimeout` (vite.config.ts, 15 s): a test has room for a slow
// wait and still fails with testing-library's own message. A test that needs several waits in a
// row is a test with several actions: split it (one action, one wait), do not raise this.
```

- [ ] **Step 5: Measure again, under load**

Ten runs of the file, as in Step 1:

```
D th-f2-after 'cd apps/web && for i in 1 2 3 4 5 6 7 8 9 10; do npx vitest run src/components/BoardColumnsSettings.test.tsx 2>&1 | grep -E "Tests|Duration|FAIL|✓|×"; done'
```

Expected: ten passing runs, and no single test of the file near the time written down in Step 1 for the old chained test.

Then the whole web suite, with as few workers as the CI runner has:

```
D th-f2-suite 'npm test -w @termhub/web -- --maxWorkers=2'
```

Expected: 0 failed. Write down the total of tests and the duration.

- [ ] **Step 6: Typecheck and commit**

Run: `D th-f2-types 'npm run typecheck -w @termhub/web'`
Expected: exit code 0.

```bash
rm -rf /home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap/.npm
```
```bash
git status --short
```
Expected: exactly the three files of this task, modified.

```bash
git add apps/web/src/components/BoardColumnsSettings.test.tsx apps/web/src/test-setup.ts apps/web/vite.config.ts
```
```bash
git commit -m "Web tests: one action per BoardColumnsSettings test" -m "The test that failed check by timeout chained three actions and four waits inside one 5 s budget, and every test of the file ended while the block was still reloading. Each action has its own test now, every test waits for the reload, and testTimeout is explicit and above testing-library's wait timeout, so a slow wait fails with its own message (TER-373)." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the task

The controller pushes the branch, opens the pull request against `main`, merges when `check` is green, follows the deploy to the health check and moves TER-373 to "Feito".
