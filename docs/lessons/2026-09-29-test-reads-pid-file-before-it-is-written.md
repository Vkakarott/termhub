---
symptom: "Error: timed out waiting for the CLI process to die"
tags: [tests, agent, flaky, ci, race]
evidence: fixed
pr: https://github.com/engenhariainversa/termhub/pull/220
agent: claude
date: 2026-09-29
---
## Cause

`apps/agent/src/claude/run.test.ts` fails `check` with the line above, in a test of the kill path,
on a change that does not touch that code. It passes on a re-run.

The test waited for the fake CLI's pid file to exist and read it right away. The fake does
`echo $$ > pid`: the shell creates the file, then writes to it. Read in between, the file is empty,
`Number('')` is `0`, and `process.kill(0, 0)` signals the test's own process group, which answers
"alive" for ever. The wait can only time out, after exactly its 5 s. The process under test was
killed all along.

The same shape fits any test that polls for a file another process writes: "the file exists" is
not "the content is there".

## Fix

Wait for the content, not for the file: `pidIn(file)` answers the pid only when the file holds a
positive integer, and `waitForPid` waits for that. `dead(pid)` throws for anything that is not a
pid, so a bad read fails with `not a pid: 0` instead of a timeout.

Before blaming the change under review for a red `check`, compare the failing test's file with
the files the change touches (`gh pr diff <n> --name-only`). To get the pull request moving while
the cause is fixed apart: `gh run rerun <run id> --failed`.

## How to check

`npm test -w @termhub/agent -- src/claude/run.test.ts` passes, and the case "answers null for a
pid file that is not there or is still empty" is in it.
