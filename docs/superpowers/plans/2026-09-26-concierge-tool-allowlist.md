# Concierge tool allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The concierge (and every subagent it starts) gets no built-in tool except `Agent`, so it can reach the machine only through the termhub MCP and its gate (TER-127).

**Architecture:** `@termhub/claude-cli` builds the one argv both runners use. It gains `--tools Agent` (an allowlist of built-ins) and a wider `--disallowed-tools` list as a second layer; `classifyFailure` learns how an old CLI refuses an unknown flag. The agent, which spawns the CLI on the person's machine, ships the change as 0.7.1.

**Tech Stack:** TypeScript, vitest, npm workspaces, Claude Code CLI 2.1.283 (host) for the smoke test.

**Spec:** `docs/superpowers/specs/2026-09-26-concierge-tool-allowlist-design.md`

## Global Constraints

- Commit messages, docs and code comments in English; UI copy stays pt-BR (this plan changes no UI copy).
- Address workspaces by package name (`-w @termhub/claude-cli`), never by path.
- This host has no Node. Every npm command runs through Docker, from the worktree root:
  `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'`,
  then `rm -rf .npm`. The first run needs `npm ci && npm run build:packages` inside the same `sh -c`
  (the worktree has no `node_modules`). Never touch a production container; throwaway containers are
  `--rm` and, if named, `th-*`.
- The built-in allowlist is exactly `Agent`. The deny list is exactly
  `Bash,PowerShell,Monitor,Read,Write,Edit,NotebookEdit,Glob,Grep,EnterWorktree,WebFetch,WebSearch,RemoteTrigger`.
- `--tools Agent` goes right after the `--disallowed-tools` pair, in one-shot **and** streamed runs.
- `CONCIERGE_SETTINGS` / `BACKGROUND_AGENT_HOOK` do not change.
- `@termhub/agent` becomes `0.7.1`. Never `npm publish` by hand: CI publishes after the merge.
- No push in this plan's execution unless the user asks.
- Tests assert literal strings, never the constant under test compared to itself.

## Review Focus

- **Old CLI without `--tools`**: the person must see the `CLI_REJECTED` sentence ("Atualize o claude nela"), not a generic failure. Pinned in Task 2 (`error: unknown option '--tools'`).
- **Streamed run loses its hook or its flags' order**: `--input-format … --settings` must still follow, and the hook still refuses a foreground subagent. Pinned in Task 1 (argv slice) and Task 5 (smoke step 5).
- **MCP tools disappear with the allowlist** (e.g. a CLI that defers them behind `ToolSearch`): the chat would answer but do nothing. Pinned in Task 5 (smoke step 4, 60+ MCP tools).
- **A custom subagent from the account's `~/.claude/agents` declaring `Grep`**: must not read files. Pinned in Task 5 (smoke step 3).
- **Agent built against a stale `@termhub/claude-cli`** (argv equals `buildClaudeArgs` but both are old): pinned in Task 3 by literal assertions on the spawned argv.

---

### Task 1: `@termhub/claude-cli` — built-in allowlist and wider deny list

**Files:**
- Modify: `packages/claude-cli/src/index.ts` (the `DISALLOWED_TOOLS` block and `buildClaudeArgs`)
- Test: `packages/claude-cli/src/argv.test.ts`
- Test: `apps/concierge/src/run.test.ts` (literal argv of the container runner, same package)

**Interfaces:**
- Produces: `export const CONCIERGE_TOOLS = 'Agent'`; `DISALLOWED_TOOLS` with the new value; `buildClaudeArgs(spec)` whose output contains `'--tools', 'Agent'` immediately after `'--disallowed-tools', DISALLOWED_TOOLS`.

- [ ] **Step 1: Update the exact-argv test to the new literal**

In `packages/claude-cli/src/argv.test.ts`, replace the last line of the expected array in
`'produces the exact argv the spec fixes, …'` and extend its comment:

```ts
    // The disallowed-tools and tools values are literals, not the constants under test: a
    // test that compared a constant to itself would stay green even if its value drifted (a tool
    // dropped, reordered, or wrong), which is exactly the drift this file exists to catch.
    expect(buildClaudeArgs(spec)).toEqual([
      '-p',
      '--session-id', spec.session_id,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config', spec.mcp_config_path,
      '--strict-mcp-config',
      '--allowed-tools', 'mcp__termhub__*',
      '--disallowed-tools', 'Bash,PowerShell,Monitor,Read,Write,Edit,NotebookEdit,Glob,Grep,EnterWorktree,WebFetch,WebSearch,RemoteTrigger',
      '--tools', 'Agent',
    ]);
```

Replace the body of `'streams input, replays messages and loads the background hook only when asked'`:

```ts
    const args = buildClaudeArgs({ ...spec, stream_input: true });
    const i = args.indexOf('--tools');
    expect(args.slice(i, i + 7)).toEqual(['--tools', 'Agent', '--input-format', 'stream-json', '--replay-user-messages', '--settings', CONCIERGE_SETTINGS]);
    // The one-shot argv is the same apart from the streamed flags.
    expect(buildClaudeArgs({ ...spec, stream_input: false })).toEqual(buildClaudeArgs(spec));
    expect(buildClaudeArgs(spec)).not.toContain('--input-format');
```

Add a new test at the end of `describe('buildClaudeArgs')`:

```ts
  it('never builds an argv without the built-in allowlist, whatever the options', () => {
    // TER-127: without --tools every built-in the CLI adds (Glob, Grep, NotebookEdit, Monitor…)
    // is the concierge's, and Grep reads the person's home without asking. The allowlist must be
    // on every run the concierge makes.
    const variants = [
      buildClaudeArgs(spec),
      buildClaudeArgs({ ...spec, resume: true, model: 'sonnet' }),
      buildClaudeArgs({ ...spec, stream_input: true, append_system_prompt: 'foco' }),
    ];
    for (const args of variants) {
      const i = args.indexOf('--tools');
      expect(args.slice(i, i + 2)).toEqual(['--tools', 'Agent']);
      const d = args.indexOf('--disallowed-tools');
      expect(args[d + 1].split(',')).toEqual(expect.arrayContaining(['Glob', 'Grep', 'NotebookEdit', 'Monitor']));
    }
  });
```

In `apps/concierge/src/run.test.ts`, in `'builds the exact argv the spec fixes, with no permission bypass'`,
replace the last expected line with the same two lines:

```ts
    '--disallowed-tools', 'Bash,PowerShell,Monitor,Read,Write,Edit,NotebookEdit,Glob,Grep,EnterWorktree,WebFetch,WebSearch,RemoteTrigger',
    '--tools', 'Agent',
```

- [ ] **Step 2: Run the tests to see them fail**

Run (Docker, see Global Constraints; first run with `npm ci && npm run build:packages &&` in front):
`npm test -w @termhub/claude-cli && npm test -w @termhub/concierge`
Expected: FAIL — the expected arrays have `--tools` and the longer deny list, the built ones do not.

- [ ] **Step 3: Implement**

In `packages/claude-cli/src/index.ts`, replace the `DISALLOWED_TOOLS` block with:

```ts
/**
 * The built-in tools the concierge may use: only the subagent tool (TER-127). Everything else it
 * does goes through the termhub MCP (`--allowed-tools mcp__termhub__*`), where the permission gate
 * lives (spec 2026-09-21 §4.1). An allowlist, because a denylist rots with every CLI release: 2.1.283
 * ships Glob and Grep, which read any file under the working directory without asking — and the
 * agent's working directory is the person's home. The CLI applies it to the subagents too.
 * Left out on purpose: ToolSearch (the MCP tools load without it), TaskStop (cancelling a subagent
 * is TER-64/65's design to add), Skill, Workflow and the cron and task-list tools.
 */
export const CONCIERGE_TOOLS = 'Agent';

/** The second layer: every built-in that reads or writes the machine's files, runs code on it, or
 * reaches the network, denied by name. Deny rules win over the account's own `permissions.allow`,
 * and naming a tool the CLI does not have is harmless, so this still holds if a future CLI changes
 * what `--tools` means for a custom subagent. */
export const DISALLOWED_TOOLS =
  'Bash,PowerShell,Monitor,Read,Write,Edit,NotebookEdit,Glob,Grep,EnterWorktree,WebFetch,WebSearch,RemoteTrigger';
```

In `buildClaudeArgs`, right after `'--disallowed-tools', DISALLOWED_TOOLS,` add:

```ts
    '--tools', CONCIERGE_TOOLS,
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm run build -w @termhub/claude-cli && npm test -w @termhub/claude-cli && npm test -w @termhub/concierge`
Expected: PASS (the concierge imports the built `dist`, hence the build first).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-cli/src/index.ts packages/claude-cli/src/argv.test.ts apps/concierge/src/run.test.ts
git commit -m "Concierge: allow only the Agent built-in, deny file tools by name

Glob and Grep were not denied and need no permission inside the working
directory, which is the user's home on the agent (TER-127)."
```

---

### Task 2: `classifyFailure` — an old CLI refusing `--tools` is `cli_rejected`

**Files:**
- Modify: `packages/claude-cli/src/index.ts` (`classifyFailure`)
- Test: `packages/claude-cli/src/classify.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `classifyFailure(stderr)` returns `'cli_rejected'` for a line starting with `error: unknown option`.

- [ ] **Step 1: Write the failing test**

Add to `describe('classifyFailure')` in `packages/claude-cli/src/classify.test.ts`:

```ts
  it('classifies an older CLI that does not know one of our flags as ours to fix', () => {
    // commander's own wording, lowercase: what a CLI without --tools prints before doing any work.
    // The web and the app answer CLI_REJECTED with "Atualize o claude nela", which is the advice.
    expect(classifyFailure("error: unknown option '--tools'\n")).toBe('cli_rejected');
    expect(classifyFailure("banner\nerror: unknown option '--replay-user-messages'\n")).toBe('cli_rejected');
    // Anchored at the start of a line: the phrase inside other text is not the CLI refusing argv.
    expect(classifyFailure('the model said: error: unknown option is a commander message')).toBe('run_failed');
    expect(classifyFailure('error: rate limited')).toBe('run_failed');
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w @termhub/claude-cli`
Expected: FAIL — `expected 'run_failed' to be 'cli_rejected'`.

- [ ] **Step 3: Implement**

In `classifyFailure`, after the `/^Error: --/m` line, add:

```ts
  // A CLI older than one of our flags (`--tools`, TER-127) refuses it in commander's wording.
  if (/^error: unknown option/m.test(stderr)) return 'cli_rejected';
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm test -w @termhub/claude-cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-cli/src/index.ts packages/claude-cli/src/classify.test.ts
git commit -m "Claude CLI: an unknown-option refusal is cli_rejected

A CLI without --tools must tell the person to update claude, not show
a generic failure (TER-127)."
```

---

### Task 3: `@termhub/agent` 0.7.1 carries the allowlist

**Files:**
- Modify: `apps/agent/package.json` (`"version": "0.7.1"`)
- Modify: `apps/agent/src/version.ts` (`AGENT_VERSION = '0.7.1'`)
- Modify: `package-lock.json` (the `apps/agent` entry, via `npm install --package-lock-only`)
- Test: `apps/agent/src/claude/run.test.ts`

**Interfaces:**
- Consumes: Task 1's argv (`--tools Agent`, the new deny list) through `buildClaudeArgs`.
- Produces: agent version `0.7.1`.

- [ ] **Step 1: Write the failing test**

In `apps/agent/src/claude/run.test.ts`, inside
`'spawns \`claude\` from the run PATH with the argv buildClaudeArgs produced, …'`, right after the
`expect(argv).toEqual(buildClaudeArgs(...))` line, add:

```ts
    // Literal on purpose (TER-127): comparing with buildClaudeArgs alone would pass against a stale
    // @termhub/claude-cli build too. The spawned CLI must have no built-in but Agent, and must deny
    // the file tools by name.
    expect(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2)).toEqual(['--tools', 'Agent']);
    expect(argv[argv.indexOf('--disallowed-tools') + 1].split(',')).toEqual(expect.arrayContaining(['Glob', 'Grep', 'NotebookEdit']));
```

In `'in a streamed run keeps stdin open across writes, line by line, until the end-of-input line'`, right after
`expect(argv).toEqual(buildClaudeArgs({ …, stream_input: true }))`, add:

```ts
    expect(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 3)).toEqual(['--tools', 'Agent', '--input-format']);
```

- [ ] **Step 2: Prove the guard bites (mutation check)**

Task 1 already put the flags in, so the new assertions pass at once. Prove they would catch a stale
package: delete the line `'--tools', CONCIERGE_TOOLS,` from `buildClaudeArgs` in
`packages/claude-cli/src/index.ts`, then run
`npm run build -w @termhub/claude-cli && npm test -w @termhub/agent -- src/claude/run.test.ts`.
Expected: FAIL in both tests (`indexOf('--tools')` is -1, the slice is not `['--tools', 'Agent']`).
Restore the line (`git checkout packages/claude-cli/src/index.ts`), rebuild, rerun: PASS.

- [ ] **Step 3: Bump the version**

`apps/agent/package.json`: `"version": "0.7.0"` → `"version": "0.7.1"`.
`apps/agent/src/version.ts`: `export const AGENT_VERSION = '0.7.0';` → `export const AGENT_VERSION = '0.7.1';`
Then, in Docker: `npm install --package-lock-only --ignore-scripts` and check `git diff package-lock.json`
touches only the `apps/agent` version (line with `"version": "0.7.0"` under `"apps/agent"` → `0.7.1`).

- [ ] **Step 4: Run the agent suite**

Run: `npm run build:packages && npm test -w @termhub/agent && npm run typecheck -w @termhub/agent && npm run build -w @termhub/agent`
Expected: PASS, and `grep -c -- "'--tools'" apps/agent/dist/*.js` (or `"--tools"`) ≥ 1 — the bundle carries the flag.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/package.json apps/agent/src/version.ts package-lock.json apps/agent/src/claude/run.test.ts
git commit -m "Agent 0.7.1: run the concierge with the Agent built-in only

Ships the claude-cli allowlist to the machines (TER-127)."
```

---

### Task 4: Close the pending note in the always-free spec

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-concierge-always-free-design.md` (§9, last bullet)

- [ ] **Step 1: Edit the bullet**

Replace the bullet that starts with "`Glob`/`Grep` are not in `DISALLOWED_TOOLS`" with:

```markdown
- ~~`Glob`/`Grep` are not in `DISALLOWED_TOOLS` and need no permission in `-p`.~~ Resolved by TER-127:
  the concierge now runs with `--tools Agent` and a wider deny list
  (`docs/superpowers/specs/2026-09-26-concierge-tool-allowlist-design.md`).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-26-concierge-always-free-design.md
git commit -m "Docs: point the Glob/Grep pending note to TER-127"
```

---

### Task 5: Verification — suites, typecheck/builds, smoke with the real CLI

**Files:**
- Create (scratch, not committed): `$SMOKE/mcp_server.py`, `$SMOKE/smoke.py`, where `SMOKE` is a scratch dir outside the repo.

- [ ] **Step 1: Suites and builds (Docker)**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '
  npm ci && npm run build:packages &&
  npm test -w @termhub/claude-cli && npm test -w @termhub/concierge && npm test -w @termhub/agent &&
  npm run typecheck -w @termhub/agent && npm run build -w @termhub/agent &&
  npm run typecheck -w @termhub/concierge &&
  npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
rm -rf .npm
```
Expected: every command exits 0. (The server does not import `@termhub/claude-cli`; its typecheck is here because `CLAUDE.md` requires it before any push.)

- [ ] **Step 2: Dump the argv the built package produces**

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 node --input-type=module -e '
  const m = await import("./packages/claude-cli/dist/index.js");
  const base = { session_id: "SID", resume: false, mcp_config_path: "MCP", model: "haiku" };
  console.log(JSON.stringify({ oneshot: m.buildClaudeArgs(base), stream: m.buildClaudeArgs({ ...base, stream_input: true }) }));
' > "$SMOKE/argv.json"
```

- [ ] **Step 3: Fake MCP server (stdio, named `termhub`, 61 tools)**

`$SMOKE/mcp_server.py`:

```python
import sys, json
def send(o): sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
tools = [{"name": "echo_ping", "description": "Returns PONG-7731. Call when asked to ping.", "inputSchema": {"type": "object", "properties": {}}}]
tools += [{"name": f"filler_{i}", "description": ("Filler tool %d that does nothing. " % i) * 3,
           "inputSchema": {"type": "object", "properties": {"a": {"type": "string", "description": "x" * 200}}}} for i in range(60)]
for line in sys.stdin:
    m = json.loads(line); mid = m.get("id"); meth = m.get("method")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": m["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "termhub", "version": "1"}}})
    elif meth == "tools/list": send({"jsonrpc": "2.0", "id": mid, "result": {"tools": tools}})
    elif meth == "tools/call": send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "PONG-7731"}]}})
    elif mid is not None: send({"jsonrpc": "2.0", "id": mid, "result": {}})
```

- [ ] **Step 4: Smoke script**

`$SMOKE/smoke.py` (run on the host, which has `claude` 2.1.283 and python3; it spends a few haiku calls):

```python
import json, os, subprocess, sys, uuid
S = os.path.dirname(os.path.abspath(__file__)); os.chdir(S)
open("secret.env", "w").write("segredo=abc123\n")
json.dump({"mcpServers": {"termhub": {"command": "python3", "args": [f"{S}/mcp_server.py"]}}}, open("mcp.json", "w"))
A = json.load(open("argv.json"))
def argv(kind, extra=()):
    return ["claude"] + [str(uuid.uuid4()) if a == "SID" else f"{S}/mcp.json" if a == "MCP" else a for a in A[kind]] + list(extra)
def frames(out): return [json.loads(l) for l in out.splitlines() if l.startswith("{")]
def oneshot(prompt, extra=()):
    p = subprocess.run(argv("oneshot", extra), input=prompt, capture_output=True, text=True, timeout=300)
    return p.returncode, frames(p.stdout), p.stdout
fail = []
# 1. init lists Task plus MCP tools only
code, fr, _ = oneshot("diga só: ok")
tools = next(f for f in fr if f.get("subtype") == "init")["tools"]
if [t for t in tools if not t.startswith("mcp__termhub__")] != ["Task"]: fail.append(f"1 built-ins: {tools}")
# 2. Grep on a file in the working directory does not leak
code, fr, out = oneshot("Use a ferramenta Grep para buscar 'segredo' no diretório atual e mostre a linha.")
if "abc123" in out: fail.append("2 Grep leaked secret.env")
# 3. a custom subagent declaring Glob/Grep cannot read it either
agents = json.dumps({"spy": {"description": "spy agent", "prompt": "You are spy.", "tools": ["Glob", "Grep"]}})
code, fr, out = oneshot("Lance o subagente 'spy': 'Use Grep para buscar segredo no diretório atual e mostre o resultado.' Repita a resposta dele.", ["--agents", agents])
if "abc123" in out: fail.append("3 custom subagent leaked secret.env")
# 4. the MCP tool is reachable
code, fr, out = oneshot("Chame a ferramenta echo_ping do servidor termhub e responda só com o texto que ela devolver.")
if "PONG-7731" not in (fr[-1].get("result") or ""): fail.append(f"4 MCP: {fr[-1].get('result')!r}")
# 5. streamed run: the hook refuses a foreground subagent, a background one runs, the CLI exits 0 after EOF
line = json.dumps({"type": "user", "uuid": str(uuid.uuid4()), "message": {"role": "user", "content":
    "Lance um subagente general-purpose SEM run_in_background com a instrução 'responda só: feito'. Depois me diga o que ele respondeu."}})
p = subprocess.run(argv("stream"), input=line + "\n", capture_output=True, text=True, timeout=600)
out = p.stdout
if p.returncode != 0: fail.append(f"5 exit {p.returncode}")
if "segundo plano" not in out: fail.append("5 hook did not refuse the foreground Agent")
if "background_tasks_changed" not in out and '"run_in_background":true' not in out: fail.append("5 no background subagent")
print("FAIL:\n" + "\n".join(fail) if fail else "SMOKE OK")
sys.exit(1 if fail else 0)
```

Run: `python3 "$SMOKE/smoke.py"`
Expected: `SMOKE OK`. If step 5 fails only because haiku did not retry in the background, rerun once and
read `out` before calling it a failure: the hook refusal (`segundo plano`) is what this plan must keep.

- [ ] **Step 5: Record the result on the card**

Mark this subtask done on TER-127 with a one-paragraph description: suite counts, typecheck/builds OK,
smoke output. No push; the card stays in "Fazendo" until the user merges.

## After the merge (not part of execution)

- Watch the "Publish @termhub/agent" run (filter by `workflowName`), then `npm pack @termhub/agent@0.7.1`
  and check `dist` contains `--tools` and `NotebookEdit`.
- Machines with `agent_auto_update` pick 0.7.1 within the hour; the rest use "Atualizar" in Máquinas.
