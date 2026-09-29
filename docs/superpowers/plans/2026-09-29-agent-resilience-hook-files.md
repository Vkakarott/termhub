# Agent resilience and hook file safety (TER-408, TER-409, TER-410, TER-412, TER-413) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent never hangs on a WebSocket handshake that gets no answer, installing the monitor hooks never replaces a file it could not read, and uninstalling them leaves no `hooks.json` behind that termhub created.

**Architecture:** Four small changes, each behind its own test. `connectOnce` passes a handshake timeout to `ws`. The ssh/local probe in `install.ts` reports one status word per file, and install refuses an unreadable one. A pure predicate in `@termhub/machine-ops` tells both uninstall paths when a Cursor `hooks.json` holds nothing of the person. The agent names the file it could not read, lists config dirs in name order, and logs a failing heal once.

**Tech Stack:** TypeScript, vitest, `ws` 8, POSIX `sh` (`@termhub/agent`, `@termhub/machine-ops`, `@termhub/server`).

**Spec:** `docs/superpowers/specs/2026-09-29-chat-and-machine-agent-roadmap-design.md` (sections 4 and 5, Front 1).

## Global Constraints

- Work only inside the worktree `/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap`, branch `fix/ter-408-agent-resilience`. Never `cd` to `/home/pedrogoiania/termhub`.
- This host shares Docker with production. Never stop, remove, kill or prune a container. Every container you start is named `th-<something>` and runs with `--rm`.
- Run git as plain, separate commands (one git command per shell call, no `&&`, no pipes): the worktree guard refuses compound commands that name git.
- Docker only, Node 22. `D '<cmd>'` below means:
  ```bash
  docker run --rm --name "th-f1-$RANDOM" -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false -e DATABASE_URL=postgresql://x:x@127.0.0.1:1/x -v "/home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap:/w" -w /w node:22 sh -c '<cmd>'
  ```
  Dependencies are already installed and the packages are already built. After each run, delete the cache the container leaves: `rm -rf /home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap/.npm`.
- `@termhub/agent` and `@termhub/server` import `@termhub/machine-ops` from its `dist`. After any change under `packages/machine-ops/src`, run `D 'npm run build -w @termhub/machine-ops'` before the agent or server tests.
- Vitest file paths are relative to the workspace: `D 'npm test -w @termhub/agent -- src/client.test.ts'`.
- Code, comments, identifiers and commit messages in English. Error messages shown to the person stay in Portuguese (pt-BR).
- Commit subject: imperative, at most 72 characters. Every commit body ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never log file contents or tokens.
- `TER-409` scope: Claude `settings.json`, Codex `config.toml` and Cursor `hooks.json` alike. ssh/local uninstall is unchanged.
- `TER-410` scope: Cursor `hooks.json` only. Claude `{}` and an empty Codex file are out of scope.
- The agent version after this plan is exactly `0.10.1`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `apps/agent/src/client.ts` | WebSocket client: connect, liveness, reconnect loop | 1 |
| `apps/agent/src/client.test.ts` | Its tests, with the fake servers | 1 |
| `packages/machine-ops/src/hooks.ts` | Pure merge/strip logic shared by agent and server | 2 |
| `packages/machine-ops/src/hooks.test.ts` | Its tests | 2 |
| `apps/agent/src/rpc/hooks.ts` | Agent-side install, heal, uninstall (node:fs) | 2, 4 |
| `apps/agent/src/rpc/hooks.test.ts` | Its tests, against a temp home | 2, 4 |
| `apps/server/src/monitor/install.ts` | ssh/local install and uninstall (one `sh` script) | 2, 3 |
| `apps/server/src/monitor/install.test.ts` | Its tests, against a temp `$HOME` | 2, 3 |
| `apps/agent/src/claude-dirs.ts` | Discovery of the machine's Claude config dirs | 5 |
| `apps/agent/src/claude-dirs.order.test.ts` | New: order test with a scrambled `readdir` | 5 |
| `apps/agent/src/run.ts` | Agent entry: wires heal to startup and reconnect | 5 |
| `apps/agent/src/run.test.ts` | Its tests | 5 |
| `apps/agent/package.json`, `apps/agent/src/version.ts`, `package-lock.json` | The release version | 6 |

---

### Task 1: Handshake timeout in the agent client (TER-408)

**Files:**
- Modify: `apps/agent/src/client.ts` (`ClientOptions`, the constants near line 77, the constructor at line 120)
- Test: `apps/agent/src/client.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ClientOptions.handshakeTimeoutMs?: number` (default 15 000 ms). `run.ts` does not set it.

- [ ] **Step 1: Write the failing tests**

In `apps/agent/src/client.test.ts`, replace the import on line 2:

```ts
import net, { type AddressInfo } from 'node:net';
```

Add this helper right after the `base` function:

```ts
/**
 * Accepts the TCP connection and never answers the upgrade: what a dead path behind a proxy looks
 * like to the agent (TLS up, request sent, no response).
 */
function startSilentServer(onConnection?: () => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.resume(); // swallow the upgrade request, answer nothing
      onConnection?.();
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        stop: () =>
          new Promise((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
```

Add this test at the end of `describe('connectOnce', …)`:

```ts
  it('rejects when the upgrade is never answered, instead of waiting forever', async () => {
    srv = await startSilentServer();
    const startedAt = Date.now();

    await expect(
      connectOnce({
        url: base(srv),
        token: TOKEN,
        hello: baseHello,
        onServerMessage: () => {},
        onStream: () => {},
        log: noopLog(),
        handshakeTimeoutMs: 100,
      }),
    ).rejects.toThrow(/handshake has timed out/i);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
```

Add this test at the end of `describe('runForever', …)`:

```ts
  it('retries after a handshake that never completes', async () => {
    let attempts = 0;
    srv = await startSilentServer(() => {
      attempts += 1;
    });
    const logs: string[] = [];
    const controller = new AbortController();

    const done = runForever(
      {
        url: base(srv),
        token: TOKEN,
        hello: baseHello,
        onServerMessage: () => {},
        onStream: () => {},
        log: (msg) => logs.push(msg),
        backoff: { minMs: 5, maxMs: 10 },
        handshakeTimeoutMs: 50,
      },
      controller.signal,
    );

    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(3), { timeout: 3_000 });
    controller.abort();

    await expect(done).resolves.toBeUndefined();
    expect(logs.filter((m) => m === 'agent connect failed').length).toBeGreaterThanOrEqual(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D 'npm test -w @termhub/agent -- src/client.test.ts'`
Expected: 2 failed. Both new tests fail with `Test timed out in 5000ms` (the promise never settles). Every other test passes.

- [ ] **Step 3: Write the implementation**

In `apps/agent/src/client.ts`, add to `ClientOptions`, after `pingIntervalMs`:

```ts
  /**
   * How long the opening handshake may take (default 15 s). `ws` sets no limit of its own, and the
   * liveness ping only starts once the socket is open: an upgrade request that never gets an answer
   * would leave `connectOnce()` pending and `runForever()` stuck on it. Tests shorten it.
   */
  handshakeTimeoutMs?: number;
```

Add next to `DEFAULT_PING_INTERVAL_MS`:

```ts
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
```

Replace the constructor call (`const ws = new WebSocket(wsUrl, { headers: … });`) with:

```ts
    // `handshakeTimeout` makes `ws` abort with the error "Opening handshake has timed out", which the
    // 'error' handler below turns into a rejection, so runForever() backs off and tries again.
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${opts.token}` },
      handshakeTimeout: opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    });
```

In the JSDoc of `connectOnce`, change "or a network error" to "a network error, or an upgrade left unanswered for `handshakeTimeoutMs`".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D 'npm test -w @termhub/agent -- src/client.test.ts'`
Expected: all tests pass, 0 failed.

Run: `D 'npm run typecheck -w @termhub/agent'`
Expected: exit code 0, no output from `tsc`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/client.ts apps/agent/src/client.test.ts
```
```bash
git commit -m "Agent: time out a WebSocket handshake that gets no answer" -m "An upgrade request left unanswered (sleep plus a network change) kept connectOnce() pending and runForever() stuck on it for hours: ws has no handshake limit and the liveness ping only starts on open. Closes #103 (TER-408)." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Uninstall deletes a Cursor hooks.json that holds nothing of the person (TER-410)

**Files:**
- Modify: `packages/machine-ops/src/hooks.ts` (after `stripCursorHooks`, near line 306)
- Modify: `apps/agent/src/rpc/hooks.ts` (imports; `uninstall`, the `strippedCursor` block near line 306)
- Modify: `apps/server/src/monitor/install.ts` (imports; `uninstallHooks`, the `strippedCursor` line near line 241)
- Test: `packages/machine-ops/src/hooks.test.ts`, `apps/agent/src/rpc/hooks.test.ts`, `apps/server/src/monitor/install.test.ts`

**Interfaces:**
- Consumes: `stripCursorHooks(current: string): string` and `mergeCursorHooks(current: string, scriptPath: string, shown?: string): string`, both already exported.
- Produces: `isBareCursorHooks(body: string): boolean`, exported from `@termhub/machine-ops`.

- [ ] **Step 1: Write the failing tests**

In `packages/machine-ops/src/hooks.test.ts`, add `isBareCursorHooks` to the import from `./hooks.js`, and add this test right after the test `'strips only our entries, drops events left empty and leaves odd files alone'` (same `describe`, so `script` is in scope):

```ts
  it('tells a hooks.json with nothing but `version` from one that holds something of the person', () => {
    expect(isBareCursorHooks(stripCursorHooks(mergeCursorHooks('', script)))).toBe(true);
    expect(isBareCursorHooks('{"version":1}')).toBe(true);
    expect(isBareCursorHooks('{}')).toBe(true);
    expect(isBareCursorHooks('{"version":1,"hooks":{"stop":[{"command":"say done"}]}}')).toBe(false);
    expect(isBareCursorHooks('{"version":1,"telemetry":false}')).toBe(false);
    expect(isBareCursorHooks('')).toBe(false);
    expect(isBareCursorHooks('[1]')).toBe(false);
    expect(isBareCursorHooks('{nope')).toBe(false);
  });
```

In `apps/agent/src/rpc/hooks.test.ts`, add these two tests right after the test `'uninstall removes only our entries from hooks.json'`:

```ts
  it('uninstall deletes a hooks.json that termhub created, and keeps ~/.cursor', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await install(params, home);
    await uninstall({}, home);
    await expect(stat(path.join(home, '.cursor/hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.cursor'))).isDirectory()).toBe(true);
  });

  it('uninstall keeps a hooks.json that still holds a key of the person', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), JSON.stringify({ version: 1, telemetry: false }));
    await install(params, home);
    await uninstall({}, home);
    expect(JSON.parse(await read('.cursor/hooks.json'))).toEqual({ version: 1, telemetry: false });
  });
```

In `apps/server/src/monitor/install.test.ts`, add these two tests right after the test `'hooks the Cursor CLI when ~/.cursor exists, keeping its own hooks, and gives them back on uninstall'`:

```ts
  it('uninstall deletes a hooks.json that termhub created, and keeps ~/.cursor', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await installHooks(machine, 'thb_hk_abc', url);
    expect(JSON.parse(await read('.cursor/hooks.json'))).toMatchObject({ version: 1 });

    await uninstallHooks(machine);

    await expect(stat(path.join(home, '.cursor/hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.cursor'))).isDirectory()).toBe(true);
  });

  it('uninstall keeps a hooks.json that still holds a key of the person', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor/hooks.json'), JSON.stringify({ version: 1, telemetry: false }));
    await installHooks(machine, 'thb_hk_abc', url);

    await uninstallHooks(machine);

    expect(JSON.parse(await read('.cursor/hooks.json'))).toEqual({ version: 1, telemetry: false });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D 'npm test -w @termhub/machine-ops -- src/hooks.test.ts'`
Expected: FAIL, `isBareCursorHooks is not a function`.

Run: `D 'npm test -w @termhub/agent -- src/rpc/hooks.test.ts'`
Expected: 1 failed, `'uninstall deletes a hooks.json that termhub created, and keeps ~/.cursor'`: the `stat` resolves instead of rejecting. The "keeps a key of the person" test passes already; it pins behaviour that must not change.

Run: `D 'npm test -w @termhub/server -- src/monitor/install.test.ts'`
Expected: 1 failed, the same "deletes" test.

- [ ] **Step 3: Write the implementation**

In `packages/machine-ops/src/hooks.ts`, add right after `stripCursorHooks`:

```ts
/**
 * True when a hooks.json holds nothing but Cursor's own `version`: what `stripCursorHooks` leaves of
 * a file termhub created itself. Uninstall deletes such a file instead of writing it back. Anything
 * the person has in it (another key, a hook of their own) makes this false, and so does a file that
 * is empty or that we cannot parse: those are never ours to delete.
 */
export function isBareCursorHooks(body: string): boolean {
  if (!body.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const file = asObject(parsed);
  return file !== null && Object.keys(file).every((key) => key === 'version');
}
```

In `apps/agent/src/rpc/hooks.ts`, add `isBareCursorHooks` to the import from `@termhub/machine-ops` (keep the list alphabetical: after `hookEnvFile`), and replace the `strippedCursor` block inside the `try` of `uninstall`:

```ts
    if (strippedCursor !== null) {
      current = `~/${CURSOR_HOOKS_REL}`;
      // nothing of the person is left in it: the file only exists because we created it
      if (isBareCursorHooks(strippedCursor)) await rm(cursorFile, { force: true });
      else await writeAtomic(cursorFile, strippedCursor, 0o644);
    }
```

In `apps/server/src/monitor/install.ts`, add `isBareCursorHooks` to the import from `@termhub/machine-ops` (after `hookEnvFile`), and add this helper right after `strippedCursorHooks`:

```ts
/** Writes what is left of hooks.json back, or removes the file when nothing of the person is left in it. */
function cursorUninstallSteps(home: string, stripped: string | null): string[] {
  if (stripped === null) return [];
  const file = `${home}/.cursor/hooks.json`;
  return isBareCursorHooks(stripped) ? [`rm -f ${shellQuote(file)}`] : replaceFile(file, stripped);
}
```

In `uninstallHooks`, replace the line

```ts
    ...(strippedCursor !== null ? replaceFile(`${home}/.cursor/hooks.json`, strippedCursor) : []),
```

with

```ts
    ...cursorUninstallSteps(home, strippedCursor),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D 'npm run build -w @termhub/machine-ops && npm test -w @termhub/machine-ops -- src/hooks.test.ts && npm test -w @termhub/agent -- src/rpc/hooks.test.ts && npm test -w @termhub/server -- src/monitor/install.test.ts'`
Expected: every test passes in the three workspaces, 0 failed.

Run: `D 'npm run typecheck -w @termhub/machine-ops && npm run typecheck -w @termhub/agent && npm run typecheck -w @termhub/server'`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/machine-ops/src/hooks.ts packages/machine-ops/src/hooks.test.ts apps/agent/src/rpc/hooks.ts apps/agent/src/rpc/hooks.test.ts apps/server/src/monitor/install.ts apps/server/src/monitor/install.test.ts
```
```bash
git commit -m "Hooks: uninstall removes a Cursor hooks.json termhub created" -m "What was left of a file we created was {\"version\": 1}, written back into a config dir that is not ours. It is deleted when nothing but version remains; a file with anything of the person in it is written back as before. Closes #105 (TER-410)." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: ssh/local install refuses a file it cannot read (TER-409)

**Files:**
- Modify: `apps/server/src/monitor/install.ts` (`MachineConfigs` near line 57, `readMachineConfigs` lines 69-97, `installHooks` after the `readMachineConfigs` call)
- Test: `apps/server/src/monitor/install.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks use. `MachineConfigs` and its helpers stay private to the file.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/monitor/install.test.ts`, add `chmod` to the import from `node:fs/promises`, and add these tests at the end of the `describe`:

```ts
  it('refuses a ~/.cursor/hooks.json that is there but cannot be read, instead of replacing it', async () => {
    // a directory in the file's place: there, not readable as a file, and it behaves the same as root
    await mkdir(path.join(home, '.cursor/hooks.json'), { recursive: true });

    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.cursor/hooks.json');

    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(home, '.cursor/hooks.json'))).isDirectory()).toBe(true);
  });

  it('refuses a Codex config that is there but cannot be read', async () => {
    await mkdir(path.join(home, '.codex/config.toml'), { recursive: true });

    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.codex/config.toml');

    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('names every file it could not read', async () => {
    await mkdir(path.join(home, '.claude/settings.json'), { recursive: true });
    await mkdir(path.join(home, '.cursor/hooks.json'), { recursive: true });

    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.claude/settings.json, ~/.cursor/hooks.json');
  });

  it.skipIf(process.getuid?.() === 0)('refuses a settings.json it has no permission to read, and leaves it as it was', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    const file = path.join(home, '.claude/settings.json');
    await writeFile(file, JSON.stringify({ model: 'opus' }));
    await chmod(file, 0o000);

    await expect(installHooks(machine, 'thb_hk_abc', url)).rejects.toThrow('Não foi possível ler ~/.claude/settings.json');

    await chmod(file, 0o644);
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({ model: 'opus' });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still creates hooks.json in a ~/.cursor that has none', async () => {
    await mkdir(path.join(home, '.cursor'), { recursive: true });

    const r = await installHooks(machine, 'thb_hk_abc', url);

    expect(r.cursor).toBe('installed');
    expect(JSON.parse(await read('.cursor/hooks.json'))).toMatchObject({ version: 1 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D 'npm test -w @termhub/server -- src/monitor/install.test.ts'`
Expected: 4 failed (the three "refuses" tests and "names every file"): each `installHooks` resolves instead of rejecting, because the probe reads an unreadable file as empty. `'still creates hooks.json…'` passes already.

- [ ] **Step 3: Write the implementation**

In `apps/server/src/monitor/install.ts`, replace the `MachineConfigs` interface with:

```ts
/** `absent`: nothing there. `present`: a regular file we can read. `unreadable`: there, but not ours to read (no permission, a directory in its place, a dangling link). */
type FileStatus = 'absent' | 'present' | 'unreadable';

interface MachineConfigs {
  home: string;
  /** each Claude dir to hook, with whether it exists there and its current settings.json */
  claude: { dir: string; exists: boolean; status: FileStatus; settings: string }[];
  codexConfig: string;
  codexStatus: FileStatus;
  hasCodex: boolean;
  cursorHooks: string;
  cursorStatus: FileStatus;
  hasCursor: boolean;
}

/**
 * One status word for a file, then its content. `cat … 2>/dev/null` alone answers the same empty
 * chunk for a file that is not there and for one we cannot read, and an install that takes the
 * second for the first writes a fresh file over what the person had. `file` is already a shell word.
 */
const probeFile = (file: string) =>
  `printf '${SEP}\\n'; if [ ! -e ${file} ] && [ ! -L ${file} ]; then echo absent; elif [ -f ${file} ] && [ -r ${file} ]; then echo present; else echo unreadable; fi; printf '${SEP}\\n'; cat ${file} 2>/dev/null`;

/** A word we do not know is read as `unreadable`: refusing is the side that loses nothing. */
const fileStatus = (chunk: string | undefined): FileStatus => {
  const word = (chunk ?? '').trim();
  return word === 'absent' || word === 'present' ? word : 'unreadable';
};
```

Replace the body of `readMachineConfigs` (keep its JSDoc, changing "(empty when absent)" to "(each with whether it is absent, present or unreadable)"):

```ts
async function readMachineConfigs(machine: Machine, claudeDirs: string[]): Promise<MachineConfigs> {
  const parts = [`printf '%s\\n' "$HOME"`];
  for (const d of claudeDirs) {
    parts.push(`printf '${SEP}\\n'; [ -d ${shDir(d)} ] && echo yes || echo no; ${probeFile(`${shDir(d)}/settings.json`)}; printf '\\n'`);
  }
  parts.push(`printf '${SEP}\\n'; [ -d "$HOME/.codex" ] && echo yes || echo no; ${probeFile('"$HOME/.codex/config.toml"')}`);
  parts.push(`printf '${SEP}\\n'; [ -d "$HOME/.cursor" ] && echo yes || echo no; ${probeFile('"$HOME/.cursor/hooks.json"')}`);
  // a missing file is part of the answer, not a failure: the last `cat` must not set the exit code
  const script = `${parts.join('; ')}; true`;
  const r = await runOnMachine(machine, { file: 'sh', args: ['-c', script] }, script);
  if (r.code !== 0) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : 'Não foi possível ler a configuração da máquina');
  const chunks = r.stdout.split(`${SEP}\n`);
  const home = (chunks[0] ?? '').trim();
  if (!home.startsWith('/')) throw new Error('Não foi possível descobrir o $HOME da máquina');
  // three chunks per file: whether its dir is there, the status of the file, its content
  const claude = claudeDirs.map((dir, i) => ({
    dir,
    exists: (chunks[1 + i * 3] ?? '').trim() === 'yes',
    status: fileStatus(chunks[2 + i * 3]),
    settings: (chunks[3 + i * 3] ?? '').replace(/\n$/, ''),
  }));
  const base = 1 + claudeDirs.length * 3;
  return {
    home,
    claude,
    hasCodex: (chunks[base] ?? '').trim() === 'yes',
    codexStatus: fileStatus(chunks[base + 1]),
    codexConfig: chunks[base + 2] ?? '',
    hasCursor: (chunks[base + 3] ?? '').trim() === 'yes',
    cursorStatus: fileStatus(chunks[base + 4]),
    cursorHooks: chunks[base + 5] ?? '',
  };
}
```

Add right after `readMachineConfigs`:

```ts
/** The files install would write over that are there but could not be read: writing would lose what the person has in them. */
function unreadableTargets(configs: MachineConfigs): string[] {
  const out: string[] = [];
  for (const c of configs.claude) {
    if ((c.dir === CLAUDE_DEFAULT_DIR || c.exists) && c.status === 'unreadable') out.push(`${c.dir}/settings.json`);
  }
  if (configs.hasCodex && configs.codexStatus === 'unreadable') out.push('~/.codex/config.toml');
  if (configs.hasCursor && configs.cursorStatus === 'unreadable') out.push('~/.cursor/hooks.json');
  return out;
}
```

In `installHooks`, right after the line `const configs = await readMachineConfigs(…);`, add:

```ts
  const unreadable = unreadableTargets(configs);
  if (unreadable.length) throw new Error(`Não foi possível ler ${unreadable.join(', ')} na máquina; nada foi alterado`);
```

`uninstallHooks` is not changed: an unreadable file still reads as empty there and is skipped.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D 'npm test -w @termhub/server -- src/monitor/install.test.ts'`
Expected: every test passes, 0 failed, 0 skipped (the container does not run as root).

Run: `D 'npm run typecheck -w @termhub/server'`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/monitor/install.ts apps/server/src/monitor/install.test.ts
```
```bash
git commit -m "Monitor: refuse to install over a config file it cannot read" -m "The probe read a file with cat and 2>/dev/null, so one it had no permission to read looked like one that was not there, and install wrote a fresh file over the person's own. The probe now answers absent, present or unreadable for the Claude, Codex and Cursor files, and install stops before writing anything. Closes #104 (TER-409)." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The agent names the file it could not read (TER-409, agent path)

**Files:**
- Modify: `apps/agent/src/rpc/hooks.ts` (helpers near line 66; `mergedCursorHooks`; `install`; `uninstall`)
- Test: `apps/agent/src/rpc/hooks.test.ts`

**Interfaces:**
- Consumes: `RpcFailure(code, message, path?)` from `../exec.js`, `readOrEmpty(file)` and `relPath(shown)` already in the file.
- Produces: nothing other tasks use.

Context: the agent never wrote over an unreadable file, because `readOrEmpty` rethrows everything except `ENOENT`. What is wrong is the answer: a Codex read failure in `install`, and any read failure in `uninstall`, escape as a raw error that the dispatcher turns into the generic `internal error`.

- [ ] **Step 1: Write the failing tests**

In `apps/agent/src/rpc/hooks.test.ts`, add these tests at the end of `describe('hooks.install', …)`:

```ts
  it('refuses a Codex config it cannot read, naming the file, and writes nothing', async () => {
    // a directory in the file's place: EISDIR on read, and it behaves the same as root
    await mkdir(path.join(home, '.codex/config.toml'), { recursive: true });
    await expect(install(params, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.codex/config.toml',
      message: expect.stringContaining('não foi possível ler ~/.codex/config.toml'),
    });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a Cursor hooks.json it cannot read, naming the file, and writes nothing', async () => {
    await mkdir(path.join(home, '.cursor/hooks.json'), { recursive: true });
    await expect(install(params, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.cursor/hooks.json',
      message: expect.stringContaining('não foi possível ler ~/.cursor/hooks.json'),
    });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a Claude settings.json it cannot read, naming the file, and writes nothing', async () => {
    await mkdir(path.join(home, '.claude/settings.json'), { recursive: true });
    await expect(install(params, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.claude/settings.json',
      message: expect.stringContaining('não foi possível ler ~/.claude/settings.json'),
    });
    await expect(stat(path.join(home, '.termhub'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
```

Add this test at the end of `describe('hooks.uninstall', …)`:

```ts
  it('names a file it cannot read and removes nothing', async () => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await install(params, home);
    await rm(path.join(home, '.codex/config.toml'), { force: true });
    await mkdir(path.join(home, '.codex/config.toml'), { recursive: true });

    await expect(uninstall({}, home)).rejects.toMatchObject({
      code: 'failed',
      path: '.codex/config.toml',
      message: expect.stringContaining('não foi possível ler ~/.codex/config.toml'),
    });
    expect(await read('.termhub/bin/termhub-hook')).toBe(HOOK_SCRIPT);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D 'npm test -w @termhub/agent -- src/rpc/hooks.test.ts'`
Expected: 4 failed.
- Codex install and uninstall: the rejection is a raw error whose `code` is `'EISDIR'`, not `'failed'`.
- Cursor and Claude install: `code` and `path` match already, the `message` does not (it is the raw `EISDIR: illegal operation on a directory, read`).

- [ ] **Step 3: Write the implementation**

In `apps/agent/src/rpc/hooks.ts`, add right after `fsFailure`:

```ts
/** The read side of `fsFailure`: a file that is there but cannot be read, named so the server can say which one. */
function readFailure(err: unknown, shown: string): RpcFailure {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new RpcFailure('eperm', `sem permissão para ler ${shown}`, relPath(shown));
  return new RpcFailure('failed', `não foi possível ler ${shown}: ${err instanceof Error ? err.message : String(err)}`, relPath(shown));
}

/** `readOrEmpty` for install and uninstall: a missing file is empty, any other failure names the file. */
async function readNamed(file: string, shown: string): Promise<string> {
  try {
    return await readOrEmpty(file);
  } catch (err) {
    throw readFailure(err, shown);
  }
}
```

Replace the body of `mergedCursorHooks` (the read moves out of the JSON `try`):

```ts
async function mergedCursorHooks(home: string, scriptPath: string): Promise<string | null> {
  if (!(await isDir(path.join(home, CURSOR_DIR_REL)))) return null;
  const current = await readNamed(path.join(home, CURSOR_HOOKS_REL), `~/${CURSOR_HOOKS_REL}`);
  try {
    return mergeCursorHooks(current, scriptPath, `~/${CURSOR_HOOKS_REL}`);
  } catch (err) {
    const message = err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `~/${CURSOR_HOOKS_REL} não é JSON válido` : err instanceof Error ? err.message : String(err);
    throw new RpcFailure('failed', message, CURSOR_HOOKS_REL);
  }
}
```

In `install`, replace the `for (const target of targets)` loop and the `mergedCodex` line:

```ts
  for (const target of targets) {
    const current = await readNamed(target.file, target.shown);
    try {
      merged.push({ target, body: mergeClaudeSettings(current, scriptPath, target.shown) });
    } catch (err) {
      // Not a JSON object (or not JSON at all): refuse rather than clobber what the user has there.
      const message = err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `${target.shown} não é JSON válido` : err instanceof Error ? err.message : String(err);
      throw new RpcFailure('failed', message, relPath(target.shown));
    }
  }
  const hasCodex = await isDir(path.join(home, CODEX_DIR_REL));
  const mergedCodex = hasCodex ? mergeCodexConfig(await readNamed(codexFile, `~/${CODEX_CONFIG_REL}`), scriptPath) : null;
```

In `uninstall`, replace the three reads. The Claude loop:

```ts
  for (const target of await claudeTargets(params.claude_dirs, home)) {
    const current = await readNamed(target.file, target.shown);
```

The Codex and Cursor reads:

```ts
  const codexConfig = (await isDir(path.join(home, CODEX_DIR_REL))) ? await readNamed(codexFile, `~/${CODEX_CONFIG_REL}`) : '';
  const cursorFile = path.join(home, CURSOR_HOOKS_REL);
  const cursorHooks = await readNamed(cursorFile, `~/${CURSOR_HOOKS_REL}`);
```

`heal` is not changed: its reads stay inside the per-item `try`, which logs and skips.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D 'npm test -w @termhub/agent -- src/rpc/hooks.test.ts'`
Expected: every test passes, 0 failed.

Run: `D 'npm run typecheck -w @termhub/agent'`
Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/rpc/hooks.ts apps/agent/src/rpc/hooks.test.ts
```
```bash
git commit -m "Agent: name the config file that could not be read" -m "A Codex config or, on uninstall, any file that failed to read escaped as a raw error and reached the person as 'internal error'. Install and uninstall now answer which file it was; nothing is written or removed in either case, as before. Part of #104 (TER-409)." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Name-ordered discovery and a heal failure logged once (TER-413, TER-412 leftovers)

**Files:**
- Modify: `apps/agent/src/claude-dirs.ts` (`candidateNames`, near line 40)
- Modify: `apps/agent/src/run.ts` (`healHooks`, lines 157-164)
- Create: `apps/agent/src/claude-dirs.order.test.ts`
- Test: `apps/agent/src/run.test.ts`

**Interfaces:**
- Consumes: `discoverClaudeDirs(home: string): Promise<string[]>`, `heal(home?: string): Promise<string[]>`.
- Produces: nothing other tasks use.

Context: commit `90024e01` fixed both cards. Two things were left. The two sibling tests in `hooks.test.ts` say "sorts first", but nothing sorts: they only discriminate when the filesystem happens to list the failing dir first. And a failure at the top of `heal` (reading `hook.env`, rewriting the script) still reaches `run.ts`, which logs it on every reconnect.

- [ ] **Step 1: Write the failing tests**

Create `apps/agent/src/claude-dirs.order.test.ts`:

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The order `readdir` answers in belongs to the filesystem (ext4 with dir_index hashes the names).
// This file scrambles it on purpose, so the test says the same thing on every machine.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  type Entry = string | { name: string };
  const nameOf = (e: Entry) => (typeof e === 'string' ? e : e.name);
  const readdir = async (dir: string, options?: unknown) => {
    const list = (await (actual.readdir as unknown as (d: string, o?: unknown) => Promise<Entry[]>)(dir, options)) as Entry[];
    return [...list].sort((a, b) => (nameOf(a) < nameOf(b) ? 1 : -1)); // the reverse of name order
  };
  return { ...actual, readdir, default: { ...actual, readdir } };
});

import { discoverClaudeDirs } from './claude-dirs.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'termhub-dirs-order-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('discoverClaudeDirs order', () => {
  it('lists the home dirs in name order, whatever order the filesystem answers in', async () => {
    for (const name of ['.claude-z', '.claude', '.claude-b', '.claude-000']) {
      await mkdir(path.join(home, name), { recursive: true });
      await writeFile(path.join(home, name, 'settings.json'), '{}');
    }

    await expect(discoverClaudeDirs(home)).resolves.toEqual(['~/.claude', '~/.claude-000', '~/.claude-b', '~/.claude-z']);
  });
});
```

In `apps/agent/src/run.test.ts`, add this test right after `'heals the monitor hooks on startup and on every session that comes up'`:

```ts
  it('logs a heal that keeps failing once, not on every reconnect', async () => {
    healMock.mockReset();
    healMock.mockRejectedValue(new Error('EACCES: permission denied'));
    const logs: string[] = [];
    runForeverMock.mockImplementation(async (opts: { onConnect?: () => void }) => {
      for (let i = 0; i < 3; i += 1) {
        opts.onConnect?.();
        await new Promise((r) => setImmediate(r));
      }
    });

    await runAgent(config, { log: (msg: string) => logs.push(msg) });
    await new Promise((r) => setImmediate(r));

    expect(healMock.mock.calls.length).toBe(4);
    expect(logs.filter((m) => m === 'monitor hooks could not be repaired')).toHaveLength(1);

    healMock.mockReset();
    healMock.mockImplementation(async () => [] as string[]);
  });

  it('logs a heal failure again once a heal has worked in between', async () => {
    healMock.mockReset();
    healMock
      .mockRejectedValueOnce(new Error('EACCES: permission denied'))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const logs: string[] = [];
    runForeverMock.mockImplementation(async (opts: { onConnect?: () => void }) => {
      for (let i = 0; i < 2; i += 1) {
        await new Promise((r) => setImmediate(r));
        opts.onConnect?.();
      }
      await new Promise((r) => setImmediate(r));
    });

    await runAgent(config, { log: (msg: string) => logs.push(msg) });
    await new Promise((r) => setImmediate(r));

    expect(logs.filter((m) => m === 'monitor hooks could not be repaired')).toHaveLength(2);

    healMock.mockReset();
    healMock.mockImplementation(async () => [] as string[]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `D 'npm test -w @termhub/agent -- src/claude-dirs.order.test.ts src/run.test.ts'`
Expected: 2 failed.
- `'lists the home dirs in name order…'`: the list comes back in reverse (`~/.claude-z` first).
- `'logs a heal that keeps failing once…'`: 4 log lines instead of 1.
- `'logs a heal failure again once a heal has worked in between'` passes already; it pins that the dedupe does not hide a failure that came back.

- [ ] **Step 3: Write the implementation**

In `apps/agent/src/claude-dirs.ts`, replace `candidateNames`:

```ts
/**
 * The `.claude*` dirs of the home, in name order; the cheap name filter keeps us from listing the
 * whole home. `readdir` answers in whatever order the filesystem keeps, so without the sort the dirs
 * would be hooked and repaired in an order that changes from one machine to the next.
 */
async function candidateNames(home: string): Promise<string[]> {
  try {
    const list = await readdir(home, { withFileTypes: true });
    return list
      .filter((d) => d.isDirectory() && d.name.startsWith('.claude'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
```

In `apps/agent/src/run.ts`, replace `healHooks` (keep the JSDoc above it):

```ts
  let lastHealError: string | null = null;
  const healHooks = () => {
    heal()
      .then((dirs) => {
        lastHealError = null;
        if (dirs.length) opts.log('monitor hooks repaired', { dirs: dirs.length });
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        // heal runs on every reconnect (backoff of 1 s at the least): say it once, and again only
        // when the failure changes or comes back after a heal that worked
        if (error === lastHealError) return;
        lastHealError = error;
        opts.log('monitor hooks could not be repaired', { error });
      });
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `D 'npm test -w @termhub/agent'`
Expected: every test file passes, 0 failed. This is the whole agent suite: the sort changes the order other tests may rely on.

If a test in `hooks.test.ts` or `claude-dirs.test.ts` now fails on the order of a list, the new order is name order (`~/.claude` first, then `~/.claude-000`, `~/.claude-a`, `~/.claude-z`, `~/.claude_pedro`): update that expectation to name order, and say so in the commit body.

- [ ] **Step 5: Prove the two sibling tests discriminate (mutation check, not committed)**

Confirm there is nothing uncommitted in the file first:

```bash
git status --short apps/agent/src/rpc/hooks.ts
```
Expected: no output.

In `apps/agent/src/rpc/hooks.ts`, inside `healClaudeDirs`, move the write out of the per-dir `try`. The loop body becomes:

```ts
    const file = path.join(expandHome(dir, home), 'settings.json');
    let body: string;
    try {
      const current = await readOrEmpty(file);
      body = mergeClaudeSettings(current, scriptPath, `${dir}/settings.json`);
      if (body === current) continue;
    } catch (err) {
      logHealSkip(dir, err, file);
      continue;
    }
    await writeAtomic(file, body, 0o644);
    healed.push(dir);
```

Run: `D 'npm test -w @termhub/agent -- src/rpc/hooks.test.ts'`
Expected: FAIL in `'repairs Cursor, Codex and a later Claude dir when an earlier settings.json cannot be written'`: the list is `['~/.cursor', '~/.codex']`, without `~/.claude-z`. This is the mutation issue #108 said the old test could not catch.

Undo the mutation:

```bash
git checkout -- apps/agent/src/rpc/hooks.ts
```

Run: `D 'npm test -w @termhub/agent -- src/rpc/hooks.test.ts'`
Expected: every test passes.

- [ ] **Step 6: Typecheck and commit**

Run: `D 'npm run typecheck -w @termhub/agent'`
Expected: exit code 0.

```bash
git add apps/agent/src/claude-dirs.ts apps/agent/src/claude-dirs.order.test.ts apps/agent/src/run.ts apps/agent/src/run.test.ts
```
```bash
git commit -m "Agent: list config dirs in name order; log a failing heal once" -m "90024e01 fixed #107 and #108; two things were left. The sibling tests only told a write inside the per-dir try from one outside it when the filesystem listed the failing dir first, so discovery now sorts. And a failure at the top of heal was still logged on every reconnect. Closes #107 (TER-412) and #108 (TER-413)." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

If Step 4 changed an expectation in another test file, add that file to the `git add` line.

---

### Task 6: Release 0.10.1 and verify the whole change

**Files:**
- Modify: `apps/agent/package.json:3`
- Modify: `apps/agent/src/version.ts:4`
- Modify: `package-lock.json` (the `"apps/agent"` entry, near line 30)

**Interfaces:**
- Consumes: everything from Tasks 1 to 5, committed.
- Produces: the version that `.github/workflows/publish-agent.yml` publishes when this branch reaches `main`. Do **not** run `npm publish`.

- [ ] **Step 1: Bump the version in the three places**

`apps/agent/package.json`, line 3:

```json
  "version": "0.10.1",
```

`apps/agent/src/version.ts`, line 4:

```ts
export const AGENT_VERSION = '0.10.1';
```

`package-lock.json`, inside the `"apps/agent": {` entry only (the line right after `"name": "@termhub/agent",`):

```json
      "version": "0.10.1",
```

Do not touch any other `0.10.0` in the repository: `TAB_MCP_MIN_AGENT_VERSION` in `apps/server/src/terminal/tab-mcp.ts`, the README and `node_modules/@xterm/addon-fit` in the lockfile are not the release version.

- [ ] **Step 2: Check the bump touched only what it should**

```bash
git diff --stat
```
Expected: exactly 3 files changed, 3 insertions, 3 deletions.

Run: `D 'npm test -w @termhub/agent -- src/version.test.ts'`
Expected: PASS (the test fails when `package.json` and `version.ts` differ).

- [ ] **Step 3: Run every suite this change can reach**

Run:
```
D 'npm run build:packages && npm test -w @termhub/agent-protocol && npm test -w @termhub/machine-ops && npm test -w @termhub/agent && npm test -w @termhub/server'
```
Expected: every workspace reports 0 failed. The server's `*.db.test.ts` files are skipped here (they need Postgres; CI runs them).

- [ ] **Step 4: Typecheck and build as CI does**

Run:
```
D 'npm run typecheck -w @termhub/agent && npm run build -w @termhub/agent && npm run typecheck -w @termhub/machine-ops && npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
```
Expected: exit code 0.

Then remove the cache and check that nothing was left in the tree:

```bash
rm -rf /home/pedrogoiania/termhub/.claude/worktrees/ter-1-407-roadmap/.npm
```
```bash
git status --short
```
Expected: only the three version files, modified.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/package.json apps/agent/src/version.ts package-lock.json
```
```bash
git commit -m "Agent: release 0.10.1" -m "Handshake timeout (#103), a named error for a config file that cannot be read (#104), uninstall that removes the hooks.json it created (#105), and the heal leftovers (#107, #108)." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Added by the review of the front

The whole-branch review found two gaps of this plan, fixed in one commit that merges before the release:

- **Dangling symlink.** Task 3 put "a dangling link" in the contract of the ssh/local probe only. On the agent, `readFile` answers `ENOENT` for it, so `readOrEmpty` read it as an absent file and the write replaced the link. `readOrEmpty` now throws `EDANGLING` for a symlink whose target is gone: install and uninstall name the file, `heal` logs the skip once and leaves the link.
- **Permission failure.** Task 4 answered `eperm` for `EACCES` and `EPERM`. The server turns every `eperm` into one fixed sentence, on purpose, so the name of the file was lost again. `readFailure` always answers `failed` now.
- Uninstall on the agent skips Cursor when `~/.cursor` is not a directory, as ssh/local does.
- The two tests of Task 5 in `run.test.ts` restore the shared mock in `afterEach`.

The delivery changed during the execution, at the person's request: one pull request per task, stacked, merged in sequence as each `check` turns green.

## After the last task

The controller, not a task subagent, does what follows:

1. Push the branch and open the pull request against `main`. The body lists the five cards, says which two were already fixed by `90024e01`, and carries `Closes #103`, `Closes #104`, `Closes #105`, `Closes #107`, `Closes #108`.
2. Merge when `check` is green.
3. Follow the run of **"CI e Deploy"** to the end, then on jarvis: `docker ps --filter name=termhub-app` (one colour, healthy), `curl -s -o /dev/null -w '%{http_code}' -H 'Host: app.termhub.dev' http://127.0.0.1/` (200) and the same with `Host: termhub.dev` (200).
4. Follow the run of **"Publish @termhub/agent"** (filter `gh run list` by `workflowName`), then `npm pack @termhub/agent@0.10.1` in the scratchpad and look for `handshakeTimeout` inside `dist`.
5. Move TER-408, TER-409, TER-410, TER-412 and TER-413 to "Feito".
