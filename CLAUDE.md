# termhub — project conventions

## Language

- **Commit messages, PR titles and PR descriptions are written in English.** Imperative subject line (≤ 72 chars), blank line, then a short body explaining the *why* when it is not obvious. Example: `Terminal: copy selection on mouse release`.
- **README.md and other repo docs are in English.**
- Code comments and identifiers are in English. Existing Portuguese comments may be translated when the surrounding code is touched; do not do mass rewrites just for that.
- The **UI copy stays in Portuguese (pt-BR)** — it is the product language. Do not translate labels, messages or e-mail templates.
- Conversation with the user may be in Portuguese; that does not change the rules above.

## Verifying before pushing

- The host that holds this checkout (jarvis) has no Node. Run typecheck/build through Docker, and only push if it passes:
  ```bash
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 \
    sh -c 'npm run typecheck -w server && npm run build -w web'
  rm -rf .npm   # cache the container leaves behind
  ```
- A push to `main` deploys to production (GitHub Actions → self-hosted runner on jarvis) via `deploy/blue-green.sh`: it builds and healthchecks the inactive color (blue/green), switches the proxy nginx vhost to it, then retires the old container — the previous container keeps serving until the switch succeeds, so there is no 502 window. A broken `check` job blocks the deploy, but do not rely on it: verify locally first.
- Migrations must stay backward compatible with the previous release: the old container keeps serving requests while the new one runs `prisma migrate deploy` and becomes healthy.
- After a deploy, confirm with `docker ps --filter name=termhub-app` (shows the active color, healthy) and `curl -s -o /dev/null -w '%{http_code}' https://termhub.dev/`.
- To roll back on jarvis: `bash deploy/blue-green.sh --rollback` (starts the other, stopped color and switches the vhost back to it).

## Architecture rules

- Routes never import Prisma directly; go through `server/src/db/repositories`.
- Every request input is validated with zod.
- Anything executed on a machine goes through `runOnMachine` / `runOnMachineWithInput` in `server/src/terminal/machine-exec.ts`; shell-quote every user-provided value with `shellQuote`, and never interpolate user input into a script unquoted.
- Terminal content is never logged; log only metadata (tab id, machine id, sizes).
