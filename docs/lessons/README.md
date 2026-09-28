# Failure lessons

A lesson is what an agent (or a person) learned fixing a non-obvious error, written down once so the
next agent that hits the same symptom finds it instead of re-diagnosing it from scratch.

- **One lesson per file**, committed with the fix (same PR). Do not batch several lessons into one
  file, and do not edit an old lesson to describe a different error — write a new one.
- **File name:** `docs/lessons/YYYY-MM-DD-<slug>.md` (the date the lesson was written, a short
  kebab-case slug). Example: `2026-09-27-stale-internal-package-dist.md`.
- `docs/lessons/README.md` (this file) is never itself indexed as a lesson.

## Format

A YAML front matter, then three sections:

```markdown
---
symptom: "<the literal error text or a short description of it>"
tags: [tag1, tag2]
evidence: fixed
card: TER-12
pr: https://github.com/org/repo/pull/123
agent: claude
date: 2026-09-26
---
## Cause

What actually caused the error — not just what fixed it.

## Fix

The exact fix: the command, the config change, the code change.

## How to check

How to confirm the fix worked (a command, an endpoint, a log line).
```

Front-matter keys:

| Key | Meaning |
|---|---|
| `symptom` | The literal error text (or close to it) — this is what makes the lesson greppable and is used as its title. |
| `tags` | A few short keywords (deploy, prisma, docker, auth…). |
| `evidence` | How sure we are it is actually fixed: `observed` (seen once, not yet proven fixed), `fixed` (the fix was applied and worked), `confirmed` (a person verified it). |
| `card` | The tracker card this was found on (e.g. `TER-57`), if any. |
| `pr` | The pull request that carries the fix, if any. |
| `agent` | Which agent wrote the lesson (`claude`, `chatgpt`…). |
| `date` | The date the lesson was written. |

## Rules

- Use the **literal error text** (or as close to it as practical) as `symptom` — that is what a later
  `grep` or search matches against.
- **Never** paste secrets, tokens, credentials or customer data into a lesson. Redact before writing.
- Keep it short: a lesson is a pointer for the next agent, not a full incident report.

## Example

See [`2026-09-27-stale-internal-package-dist.md`](./2026-09-27-stale-internal-package-dist.md) for a
real lesson from this repository's history.
