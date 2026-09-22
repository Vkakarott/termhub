# The concierge runs on the user's own machine, on their own account

**Status:** proposed — supersedes the runtime half of `2026-09-20-chat-concierge-design.md` (§4). The gate, the cards, the conversation model and the MCP boundary described there are unchanged by this document.

## 1. The problem

The chat concierge runs `claude -p` inside one container on the server, with one `CLAUDE_CONFIG_DIR` mounted from the operator's own Claude account. Every user's conversation therefore runs on the operator's account, which means:

- **The bill and the rate limit are the operator's.** A second user's conversation consumes the operator's quota, and there is nothing in the product that says so.
- **The account is a single point of contention.** Two users chatting at once are two `claude` processes writing into the same config directory, which nobody has tested.
- **`CONCIERGE_SECONDARY_CONFIG_DIR` is mounted, passed to `ChatService` and never read** — `config_dir` is always `primary` (`apps/server/src/chat/service.ts`). The fallback promised in the earlier design does not exist.

Data isolation is *not* part of this problem and is already sound: the MCP token is minted for the user who sent the message, the control context is self-scoped ("never view as, even for admins"), and every tool resolves ids through an owner check. What is wrong is **whose computer and whose account do the thinking**.

The intent, in the user's words: a user with their own machines should get a "terminal geral" of their own, pointed at their own Claude account, and the orchestration should happen there.

## 2. What this reuses

This is a smaller change than it sounds, because both seams already exist:

- **`RunnerClient`** (`apps/server/src/chat/runner.ts`) is already an interface with one implementation (`httpRunner`). Everything above it — the conversation, the busy lock, the gate, the cards, the retry on a missing session, the bus events — is written against the interface, not the container.
- **The agent protocol already streams.** `serverMessage` carries `open` with a `kind` (today only `'pty'`), answered by `opened` / `open_error` / `closed` and a data channel. That is exactly the shape a CLI's stdout needs, so no new streaming mechanism is invented here.
- **`ai_accounts`** already models "a CLI account on a machine", with `config_dir` for a second login.
- **`chat_conversations` already has `machine_id` and `tab_id`** columns, unused today.

## 3. The model: one general terminal per user

A user's chat has **one host machine** and **one AI account on that machine**. That pair is the "terminal geral".

**Why one host and not one per machine.** The CLI's session lives in the config directory of the machine that ran it, so `--resume` only works there. A conversation that hopped between machines would lose its history on every hop. One host keeps the single conversation the product promises.

**The other machines are not cut off.** The host is only where the model runs; it reaches every other machine of that user through the MCP, exactly as it does today. A user with three machines has one host and three manageable machines.

**Defaults and choice.** With one machine, it is the host, chosen automatically, with nothing asked. With more than one, the user picks, and can change it. Changing the host starts a fresh CLI session: the conversation's transcript is ours and survives, but the model's session memory does not, and the screen says so before the change is made.

**When the host is offline**, the chat says so and stops. It does not silently fall back to the operator's container — that would spend the operator's credit exactly when nobody is watching, and hide from the user that their machine was not involved. The message names the machine and offers to change the host.

## 4. The protocol

`open` gains a second kind:

```
{ type: 'open', ch, kind: 'claude', params: {
    session_id, resume, config_dir, mcp_url, token, model?
} }
```

- The agent answers `opened`, streams the CLI's stdout as channel data (one `stream-json` line per frame boundary is not guaranteed; the server reassembles by newline, as the container's reader already does), and ends with `closed` carrying the exit code.
- `close` from the server kills the process — the deadline and an abandoned request both travel this way, replacing the container's `AbortSignal.timeout`.
- The prompt goes in on **stdin**, never argv: a prompt beginning with `-` must not become a flag, and argv is visible to every process on the user's machine.
- `token` is the user's own MCP token, minted per run exactly as today. It travels to a machine that user controls, to act as that user — no new authority crosses a boundary.

**Version and rollout.** This is an additive protocol change: a server that knows `kind: 'claude'` must tolerate an agent that does not. The agent advertises what it supports in its `hello`; the server treats a host whose agent is too old exactly like an offline host, naming the version and pointing at the update button.

## 5. The tool restrictions travel with it

The container runs the CLI with `--strict-mcp-config`, `--allowed-tools mcp__termhub__*` and `--disallowed-tools Bash,Read,Write,Edit,WebFetch,WebSearch`. Those flags matter **more** on the user's own machine, not less: there the model would be one `Bash` away from the user's home directory, outside the gate that exists to protect them from an agent acting without a confirmation.

So the flag list stops living in `apps/concierge/src/run.ts` and moves to a place both runners build from, with a test that pins the exact argv on each side. A future flag added to one and forgotten in the other is the failure this prevents.

## 6. What happens to the container

It stays, unchanged, for one case: a user with no machine of their own — which today is every account that has not enrolled one. The operator's own chat may keep using it or move to a host like anyone else.

Say the consequence plainly, because it is the one thing this design does not fix: **for a user with no machine, the operator still pays and the operator's account still runs their conversation.** That is exactly the situation this document set out to end, so it is not something to leave to chance — either the chat stays granted only to users who have enrolled a machine (the role that gates it today makes that a decision, not an accident), or the container is eventually retired and a user with no machine simply has no chat. This spec does not decide which; it refuses to let the case be invisible.

The `secondary` config dir is dropped from the server's configuration. It was a workaround for one shared account; with a per-user account the same need is expressed properly — a second `ai_account` on the host, chosen by the user — and that is out of scope here (see §9).

## 7. Data model

- `chat_conversations.machine_id` starts being used: the host.
- `chat_conversations.ai_account_id` is added (nullable, `ON DELETE SET NULL`): the account on that host. Null means "the machine's default Claude config dir".
- Deleting the machine or the account nulls the field; the next message asks the user to choose again rather than guessing.
- The settings screen shows the pair and lets the user change it, with the fresh-session warning.

## 8. Security and privacy

- **No new authority.** The token is the user's own, scoped to them, gated as today. It reaches a machine they own, over the connection that machine already holds to the server.
- **The gate is untouched.** Writes still stop for a card in that user's own conversation.
- **The operator loses access, on purpose.** After this, the operator's account no longer runs other people's conversations, and the operator's Claude history stops accumulating other people's prompts — which is the privacy half of the same fix.
- **The prompt never touches argv**, and the agent's logs must not carry it: the same rule the container follows (stderr never leaves) applies to the agent's channel.

## 9. Out of scope

- A second account per user as an automatic fallback when the first runs out of credit. The mechanism (pick an `ai_account`) is here; the policy is a separate decision.
- A visible terminal tab the user can watch the concierge work in. The headless stream is what every existing parser, card and delta depends on; a visible tab is a second presentation, worth its own design.
- Queueing a message until an offline host returns.
- Moving the operator's own chat off the container.

## 10. Risks

- **A protocol change means an agent release**, and a machine that does not auto-update stays on the old one. The "too old" path must read as a plain instruction, not an error.
- **The user's machine sleeps.** A laptop that closes mid-answer produces a `closed` with no `done` frame; that is the existing `RUNNER_FAILED` path, but it will happen far more often than a container dying, so the message must say what happened in a way that does not read as a bug in the product.
- **Two conversations on one host** (the same user, two browser tabs) are still serialised by the conversation lock, unchanged. Two *users* sharing a host cannot happen: the host is a machine the user owns.
