# termhub — project conventions

## Language

- **Commit messages, PR titles and PR descriptions are written in English.** Imperative subject line (≤ 72 chars), blank line, then a short body explaining the *why* when it is not obvious. Example: `Terminal: copy selection on mouse release`.
- **README.md and other repo docs are in English.**
- Code comments and identifiers are in English. Existing Portuguese comments may be translated when the surrounding code is touched; do not do mass rewrites just for that.
- The **UI copy stays in Portuguese (pt-BR)** — it is the product language. Do not translate labels, messages or e-mail templates.
- Conversation with the user may be in Portuguese; that does not change the rules above.

## Layout

npm workspaces: `apps/server` (`@termhub/server`), `apps/web` (`@termhub/web`), `apps/landing` (`@termhub/landing`, static site for termhub.dev). Always address workspaces by package name (`-w @termhub/server`), never by path.

## Verifying before pushing

- The host that holds this checkout (jarvis) has no Node. Run typecheck/build through Docker, and only push if it passes:
  ```bash
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 \
    sh -c 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing'
  rm -rf .npm   # cache the container leaves behind
  ```
- **This checkout shares the host with production.** `termhub-app-blue` / `termhub-app-green` (the live app, one active and the other kept stopped for rollback), `termhub-db-1`, `termhub-landing`, `termhub-whisper-1`, `termhub-concierge-1`, `termhub-mailpit-1` and the proxy (`proxy-nginx`, `proxy-cloudflared`) are the live site, and so are the other `*-app-*` stacks next to them. Never remove, stop, kill or prune them, never bring the prod compose project down, and never reuse one of those names: a throwaway container for a test or an `nginx -t` check is named `th-<something>` (e.g. `th-test-db`, `th-app-stand-in`), so a name clash can never turn into "remove the existing container to free the name". A user-level hook (`~/.claude/hooks/protect-prod-containers.py`) refuses those commands; if it fires, the action was wrong, not the hook. Only `deploy/blue-green.sh`, run by CI, touches the colors.
- A push to `main` deploys to production (GitHub Actions → self-hosted runner on jarvis) via `deploy/blue-green.sh`: it builds and healthchecks the inactive color (blue/green), switches the proxy nginx vhost to it, then retires the old container after a grace period — the previous container keeps serving until the switch succeeds, so there is no HTTP 502 window; open terminal WebSockets pinned to the old container reconnect (to the new one) when it stops. A broken `check` job blocks the deploy, but do not rely on it: verify locally first.
- Migrations must stay backward compatible with the previous release: the old container keeps serving requests while the new one runs `prisma migrate deploy` and becomes healthy.
- **`@termhub/agent` is published by CI, not by hand.** The `publish-agent.yml` workflow runs on every push to `main`, compares the version in `apps/agent/package.json` with the registry and publishes when it changed. So bumping that version in a PR is the whole release: do not run `npm publish` — npm is not even authenticated on jarvis, and a manual publish would race the workflow. After the merge, check the run named "Publish @termhub/agent" (it is a separate workflow from "CI e Deploy", so `gh run list --limit 1` often shows the wrong one — filter by `workflowName`), then confirm the artifact rather than the version number: `npm pack @termhub/agent@<version>` and look inside `dist` for the change you expect. Machines with `agent_auto_update` pick the release up within the hour; the rest use the update button in Máquinas.
- After a deploy, confirm with `docker ps --filter name=termhub-app` (shows the active color, healthy) and, on jarvis, the switched vhost through the local proxy nginx: `curl -s -o /dev/null -w '%{http_code}' -H 'Host: app.termhub.dev' http://127.0.0.1/` (app, expect 200) and the same with `Host: termhub.dev` (landing, expect 200). From outside, `https://termhub.dev/` answers 200, but `https://app.termhub.dev/` answers 302 to `*.cloudflareaccess.com`: Cloudflare Access sits in front of the app, so that redirect only proves the tunnel and Access are up, not the app. To call the app's API through Access from a script or CI, use a Cloudflare Access service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers) with a Service Auth policy on the Access application.
- To roll back on jarvis: `bash deploy/blue-green.sh --rollback` starts the other, stopped color and switches the vhost back to it — but only once a color has been active at least once. **Right after the very first blue/green deploy**, there is no stopped color yet; the only fallback is the retired legacy container (`termhub-app-legacy`, renamed and stopped, not removed). Roll back to it by hand: `docker start termhub-app-legacy`, edit `proxy_pass` in the vhost (`/mnt/hd2tb/proxy/nginx/conf.d/termhub.dev.conf`) to `http://termhub-app-legacy:3000;`, `docker exec proxy-nginx nginx -t && docker exec proxy-nginx nginx -s reload`, then stop the color that `deploy/blue-green.sh` started (`docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.proxy.yml --profile prod stop app-<color>`).

## Architecture rules

- Routes never import Prisma directly; go through `apps/server/src/db/repositories`.
- Every request input is validated with zod.
- Authorization is role-based (`apps/server/src/auth/permissions.ts`): register new route plugins through `guarded(resource, plugin, prefix)` in `app.ts`, add new resources to the `RESOURCES` catalog, and never check roles by name in handlers — check `resource:action` grants (admins bypass).
- Data is scoped by owner (`apps/server/src/auth/scope.ts`): machines, projects and integrations have `owner_id`; tabs, tasks, notes and tickets follow their project, and a tab also runs on a machine of the same scope (`project_machines`). In routes, load machines/projects/tabs/tasks/integrations/AI accounts through `scoped(repos, request).<kind>(id)` (404 outside the scope), pass `request.scope.ownerId` to list methods and `request.scope.createAs` as the owner of new rows. Never use `repos.*.findById` directly in a handler for these kinds.
- Anything executed on a machine goes through `runOnMachine` / `runOnMachineWithInput` in `apps/server/src/terminal/machine-exec.ts`; shell-quote every user-provided value with `shellQuote`, and never interpolate user input into a script unquoted.
- Terminal content is never logged; log only metadata (tab id, machine id, sizes).
