---
symptom: "API Error: 400 tools.37.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12"
tags: [mcp, json-schema, zod, regex, claude-api]
evidence: fixed
card: TER-626
agent: claude
date: 2026-09-30
---
## Cause

A zod `.regex()` in a tool's `input` becomes a `pattern` in the JSON schema the MCP server lists. The
pattern `^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$` (the `model` of `start_agent`, TER-589) has a bare `[`
inside a character class. JavaScript accepts it without flags or with `u`. The Claude API's validator
reads it as the start of a nested class that never closes, and rejects the whole tool list with a 400.

Every Claude session that loads the termhub MCP died at start: the concierge, its subagents and the
tabs. The index in `tools.N` counts the session's whole tool array, Claude Code's built-in tools
included, so it does not match the position in the MCP's `tools/list`.

## Fix

- Escape every `[`, `]` and `-` inside a class in any pattern that reaches a tool schema:
  `^[A-Za-z0-9][A-Za-z0-9._:\[\]\-]{0,99}$`.
- `apps/server/src/mcp/tools-schema.test.ts` lists every tool through the real `tools/list` and:
  - compiles each `input_schema` with Ajv's draft 2020-12 in strict mode;
  - compiles each `pattern` with ECMAScript's strictest flag, `v`, which rejects bare `[`/`-` in a
    class the same way nested-class engines do.

## How to check

- `npx vitest run src/mcp/tools-schema.test.ts` passes. Putting the unescaped pattern back makes it fail
  on `start_agent`.
- In production, a new concierge conversation answers instead of dying with the 400.
