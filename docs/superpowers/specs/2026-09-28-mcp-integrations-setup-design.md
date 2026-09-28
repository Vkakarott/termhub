# MCP: integrations and the project repository setup — design

Card: **TER-336**. Unblocks TER-300 (phase 2 of TER-183: the CI panel needs a GitHub integration and
the project's repository in its Setup, which today only the web screens can set).

## 1. Goal

Let an MCP client (the chat concierge, or a personal token such as Claude Code's) list integrations,
create a GitHub integration from the `gh` login of one of the user's machines, and read and change
the project's repository setup (integration, `owner/repo`, deploy workflow) — without the token ever
passing through a tool argument, the chat text, a confirmation card, a tool result or a log line.

## 2. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | The secret never travels as a tool argument. `create_integration` takes `secret_from: { machine_id, source: 'gh_auth_token' }`; the server asks that machine's agent for it through a new agent RPC `secret.read`, and stores it encrypted. | Tool arguments are stored in `chat_actions.args`, shown on the confirmation card and in the audit trail. A token there would leak. The machine-to-server path is the one `ai.credential` already uses for CLI credentials. |
| D2 | `secret.read` supports one source only, `gh_auth_token` (`gh auth token`). No generic file or command source. | A file source plus a provider whose endpoint is configurable (Jira `baseUrl`) would let a prompt-injected chat send any file of the machine to any host. `gh auth token` is the first use; new sources get added one by one, each with its own review. |
| D3 | `create_integration` accepts provider `github` only, for the same reason (the only source is a GitHub login). It tests the token against GitHub (`testConnection`) before saving and stores `config.login` like the web screen does. A failing test saves nothing. | Matches the web flow; never stores a token that does not work. |
| D4 | Setup writes are limited to the repository block: `set_project_repo { project_id, integration_id, full_name, deploy_workflow?, base_branch? }`. The integration must be a GitHub integration of the project's owner (the same owner rule the CI sync enforces). | The card asks for integration, repository and deploy workflow; ticket sources, runner, agent and approvals stay on the web screen (YAGNI, smaller blast radius). |
| D5 | Reads (`list_integrations`, `get_project_setup`) need token scope `read` plus the user's `integrations:read` / `projects:read` grants. Writes (`create_integration`, `set_project_repo`) need token scope `terminals` plus `integrations:create` / `projects:update`. | A token that can already run commands on the user's machines is at the highest trust level; changing credentials must not be possible for weaker tokens (read/tasks/memory ones, such as future per-tab tokens). No new scope: existing full tokens keep working, no token re-issue. |
| D6 | In the chat gate, `create_integration` and `set_project_repo` are `irreversible`: always a confirmation card, never grantable ("permitir sem confirmar"). The reads are `read`. | Configuration changes with a secret (card requirement); a prompt injection cannot switch the integration or the repository without the person seeing it. |
| D7 | `list_integrations` returns `id, provider, name, config` (non-secret: GitHub `login`, Jira `baseUrl`/`email`), `created_at`; never the secret. `create_integration` returns the same shape plus `account`. | The repository already maps integrations without the secret; the tool result goes to the model. |
| D8 | Agent `@termhub/agent` 0.9.0 ships `secret.read`. On an older agent the server answers `AGENT_OUTDATED` ("atualize o agente da máquina para 0.9.0 ou mais novo"). | RPC methods are versioned by agent release; the error tells the person what to do. |

## 3. Pieces

- `packages/agent-protocol/src/rpc.ts`: `'secret.read': def(z.object({ source: z.enum(['gh_auth_token']) }), z.object({ value: z.string().max(4096) }), 10_000)`.
- `apps/agent/src/rpc/secret.ts`: runs `gh auth token` through `sh`, trims, never logs stdout; non-zero exit → `RpcFailure('failed', 'gh auth token failed')`; empty → `failed`. Registered in `rpc/index.ts`. Version 0.9.0.
- `apps/server/src/integrations/machine-secret.ts`: `readMachineSecret(machine, source)` — agent machines only (others: `UNSUPPORTED_MACHINE`); maps offline/timeout/RPC errors to fixed messages (never forwards the agent's text, like `readCredential`); unknown method → `AGENT_OUTDATED`; validates the value (1–4096 chars, no whitespace).
- `apps/server/src/control/integrations.ts`: `listIntegrations(ctx, { provider? })`, `createIntegration(ctx, { provider, name, secret_from })`, `getProjectSetup(ctx, { project_id })`, `setProjectRepo(ctx, {...})` — owner-scoped through `ctx.scoped`, repositories only, `ControlError` codes.
- `apps/server/src/mcp/tools.ts`: the four tools. `apps/server/src/chat/gate.ts`: classification (D6).
- The concierge prompt needs no change: tools are listed from `TOOLS`.

## 4. Errors

`MACHINE_OFFLINE`, `AGENT_OUTDATED`, `SECRET_UNAVAILABLE` ("`gh auth token` falhou na máquina X: rode `gh auth login` nela"), `INTEGRATION_TEST_FAILED` (GitHub's answer status, never the token), `INTEGRATION_NOT_ALLOWED` (not GitHub, or not of the project's owner), `INVALID_REPO` (`owner/repo` shape). All pt-BR.

## 5. Testing

Agent: `secret.read` with a fake `sh` (ok, non-zero, empty, output never in the error). Server:
`readMachineSecret` error mapping; control operations with in-memory repos (owner scoping, test
failing saves nothing, result has no secret, `set_project_repo` keeps the rest of the setup);
MCP tool schema rejects a `secret` argument; gate classification.

## 6. Out of scope

File/stdin sources, Linear/Jira creation through MCP, deleting/renaming integrations, the other
setup blocks, a tool to update agents.
