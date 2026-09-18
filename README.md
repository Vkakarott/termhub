<p align="center">
  <a href="https://github.com/engenhariainversa/termhub">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img src=".github/assets/logo-light.svg" alt="termhub — your machines' terminals, in the browser" width="480">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/engenhariainversa/termhub/actions/workflows/deploy.yml"><img alt="CI and deploy" src="https://github.com/engenhariainversa/termhub/actions/workflows/deploy.yml/badge.svg"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 20+" src="https://img.shields.io/badge/node-%3E%3D%2020-3fb950?logo=node.js&logoColor=white"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-4f8cff?logo=typescript&logoColor=white"></a>
  <a href="#production-docker"><img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-9aa1b1"></a>
  <a href="https://github.com/engenhariainversa/termhub/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-bc8cff"></a>
  <a href="https://buymeacoffee.com/pedrogoiania"><img alt="Buy me a coffee" src="https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-FFDD00?logo=buymeacoffee&logoColor=black"></a>
</p>

Self-hosted web app to reach the terminals of the machines on your local network from the browser, organized as **Machines > Projects > Tabs**. Each tab is a `tmux` session on the target machine — closing the browser does not kill the shell.

- **Backend:** Node.js + Fastify, WebSocket (`ws`), `node-pty`, Postgres + Prisma (versioned migrations) behind an isolated repository layer
- **Frontend:** React + Vite + xterm.js (fit + webgl), Tailwind
- **Auth:** e-mail code (OTP), optional password (argon2), Google OAuth (PKCE), Cloudflare Access (JWT); rate limiting with progressive lockout, CSRF
- **Production:** Docker (Fastify serves the frontend build on port 3000); Cloudflare Tunnel or direct LAN access

## Requirements

- Docker + Docker Compose (Postgres, Mailpit and, optionally, the app)
- To run the app on the host: Node.js 20+ and `tmux`
- On every SSH machine: `tmux` installed and termhub's public key in `~/.ssh/authorized_keys`

## Development

```bash
npm install                 # server + web (compiles node-pty and argon2)
cp .env.example .env        # defaults already point to the compose Postgres/Mailpit
docker compose up -d        # Postgres on localhost:5434 + Mailpit (UI at http://localhost:8025)
npm run prisma:migrate      # applies migrations (create new ones with: npm run prisma:migrate -- --name <name>)
npm run create-user -- --email you@example.com --name "Your Name"   # first user becomes owner
npm run dev                 # API on :3000 + Vite on :5173 (proxies /api and /ws)
```

Open http://localhost:5173, enter your e-mail and grab the 6-digit code from Mailpit (http://localhost:8025). The "local" machine is created automatically on first boot (`SEED_LOCAL_MACHINE=true`).

Everything inside Docker, with hot reload (`Dockerfile.dev`):

```bash
docker compose --profile dev up --build
```

## Production (Docker)

```bash
cp .env.example .env        # adjust: HOST/BIND_ADDR, PUBLIC_URL, POSTGRES_PASSWORD, SMTP_*, ENCRYPTION_KEY
bash deploy/blue-green.sh   # builds the image and switches the active blue/green container (see deploy/blue-green.sh)
docker exec termhub-app-$(cat /mnt/hd2tb/projetos/termhub/active-color) node apps/server/dist/cli/create-user.js you@example.com "Your Name"
```

`app-blue`/`app-green` publish no host port on their own — the proxy nginx reaches whichever one is active over the external `proxy` docker network. Without that proxy, publish a port yourself (e.g. a local compose override with `ports: ["127.0.0.1:3000:3000"]`) before running a single color directly.

### CI/CD (GitHub Actions → jarvis)

`.github/workflows/deploy.yml`: on every push to `main` (and on PRs) the **check** job runs on GitHub (npm ci, server/web typecheck, build, `prisma migrate deploy` + `migrate diff --exit-code` against an ephemeral Postgres — guarantees the migrations match the schema). If it passes and the event is a push to `main`, the **deploy** job runs on the **self-hosted runner on jarvis** (`/mnt/hd2tb/github-runner-termhub`, labels `jarvis,termhub`): checkout → `bash deploy/blue-green.sh` (builds and healthchecks the inactive blue/green color, switches the proxy nginx vhost to it, then retires the old container — no downtime) → `prisma migrate status` against the now-active container.

The production `.env` **lives only on the server** (`/mnt/hd2tb/projetos/termhub/.env`, chmod 600); no secret goes through GitHub. To change a variable: edit the file there and re-run the workflow (or `bash deploy/blue-green.sh` by hand). The compose file has a fixed `name: termhub`, so volumes (`termhub_pgdata`, `termhub_sshkeys`) do not depend on the checkout directory.

**Rollback:** `bash deploy/blue-green.sh --rollback` starts the other, stopped color and switches the vhost back to it — but only once a color has been active at least once. Right after the very first blue/green deploy there's no stopped color yet; the only fallback then is the retired legacy container (`termhub-app-legacy`, renamed and stopped, not removed) — roll back to it by hand: `docker start termhub-app-legacy`, point the vhost's `proxy_pass` at `http://termhub-app-legacy:3000;`, `docker exec proxy-nginx nginx -t && docker exec proxy-nginx nginx -s reload`, then stop the color the deploy started.

Runner as a service (once, needs sudo): `cd /mnt/hd2tb/github-runner-termhub && sudo ./svc.sh install pedrogoiania && sudo ./svc.sh start`.

The `Dockerfile` produces a slim image (tmux + ssh) and the entrypoint runs `prisma migrate deploy` on every boot. Main variables:

| Variable | Value |
| --- | --- |
| `BIND_ADDR` | host IP that publishes Mailpit's UI port (`127.0.0.1` or `0.0.0.0`) — the prod app itself publishes no host port, it's reached through the proxy nginx (see below) |
| `PUBLIC_URL` | `http://192.168.x.x:3000` or `https://termhub.yourdomain.com` |
| `SMTP_HOST` | `mailpit` (local inbox, UI on `:8025`) or a real SMTP server (Mailgun etc.) |
| `SEED_LOCAL_MACHINE` | `false` — inside Docker, "local" would be the container |

**Inside Docker, the host itself must be registered as an SSH machine.** The container generates a key on first boot (`sshkeys` volume); the public key shows up in the new-machine form and in the log (dev: `docker compose logs app-dev | grep key`; prod blue/green: `docker logs termhub-app-$(cat /mnt/hd2tb/projetos/termhub/active-color) | grep key`). Authorize it on the host and register `host.docker.internal` as the host (with the host's SSH user and port). Install `tmux` on the host.

### Without Docker (Node on the host)

```bash
npm run build && NODE_ENV=production npm start
```

### Boot service (without Docker)

Detects the OS and installs a user service (launchd on macOS, systemd on Linux):

```bash
npm run build
npm run install-service      # creates and starts the service
npm run uninstall-service
```

Logs on macOS: `data/logs/`. On Linux: `journalctl --user -u termhub -f` (use `loginctl enable-linger $USER` to start without an open session).

### Cloudflare Tunnel

On jarvis, the app is published at **https://app.termhub.dev** and the landing page at **https://termhub.dev** through the existing proxy (`/mnt/hd2tb/proxy`: nginx + `cloudflared`, tunnel "jarvis"). The `docker-compose.proxy.yml` overlay puts `app-blue`/`app-green` on the external `proxy` docker network; deploys are blue-green (see `deploy/blue-green.sh`): the `nginx/conf.d/termhub.dev.conf` vhost, rendered from `deploy/nginx/termhub.dev.conf.tmpl`, does `proxy_pass http://termhub-app-<active color>:3000` with WebSocket upgrade, and the script switches it to the newly healthy color before retiring the old one, so there is no 502 window. The public hostnames are managed in the Zero Trust dashboard → Tunnels → jarvis (`app.termhub.dev` and `termhub.dev` → HTTP → `proxy-nginx:80`; the vhost template `deploy/nginx/termhub.dev.conf.tmpl` sends `termhub.dev` to the `termhub-landing` container and `app.termhub.dev` to the active app color; the tunnel is dashboard-managed, so `cloudflared tunnel route dns` alone is not enough: it only creates the DNS record, and it uses the zone `~/.cloudflared/cert.pem` was logged into). To run compose by hand on jarvis, export `ENV_FILE=/mnt/hd2tb/projetos/termhub/.env` (the services' `env_file` uses that variable).

On another server, the simple path is `cloudflared tunnel --url http://127.0.0.1:3000`.

Set `PUBLIC_URL=https://app.termhub.yourdomain.com` in `.env` (`secure` cookies + Google redirect). If you protect it with **Cloudflare Access**, set `AUTH_MODE=app,cloudflare`, `CF_TEAM_DOMAIN` and `CF_AUD` — the server validates the `Cf-Access-Jwt-Assertion` JWT on every request in addition to the app session.

On jarvis, `app.termhub.dev` sits behind a Cloudflare Access self-hosted application ("termhub") with an e-mail **allowlist** policy; the landing at `termhub.dev` stays public. The allowlist is managed with a script on the server that talks to the Access API using an API token (Account · Access: Apps and Policies · Edit) stored in `~/.cloudflare/access-token`: `bash ~/cf-access-allowlist.sh a@x.com b@y.com` replaces the policy with exactly those e-mails. The tunnel's own `cert.pem` token can read but not edit Access.

## Users and login

There is no public sign-up. Invite people from the app (sidebar → ⚙ Configurações → Usuários → **Convidar**: e-mail, optional name, role) or create users through the CLI:

```bash
npm run create-user -- --email you@example.com --name "Your Name" [--password ...] [--role ADMIN|MANAGER|AUTHENTICATED]
# Docker (prod blue/green): docker exec termhub-app-$(cat /mnt/hd2tb/projetos/termhub/active-color) node apps/server/dist/cli/create-user.js you@example.com "Your Name"
```

- **E-mail code (default):** enter the e-mail, receive a 6-digit code (expires in `LOGIN_CODE_TTL_MINUTES`, 5 attempts, max 3 sends every 10 min). Unknown e-mails get the same response, with no e-mail sent.
- **Password:** optional (`--password`); "Sign in with password" button on the login screen.
- The first user gets the `ADMIN` role; later ones `AUTHENTICATED` unless `--role` says otherwise.
- **Invites:** an invite creates the user with the chosen role (no password), adds the e-mail to the Cloudflare Access allowlist when `CF_ACCOUNT_ID`/`CF_API_TOKEN` are set (see below) and sends an invite e-mail with the app link; the person then signs in with Google or an e-mail code. The users table shows who is still a pending invite (never signed in), whether each e-mail is in the Access allowlist, and lets you resend the invite (↻: e-mail + allowlist again). Deleting a user also removes the e-mail from the allowlist.
- **Google:** set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and register `<PUBLIC_URL>/api/auth/google/callback` as an authorized redirect URI in the Google Cloud Console. By default only e-mails already registered can sign in (the `google_id` is linked on first sign-in). With `AUTH_GOOGLE_SIGNUP=true`, an unknown Google account creates the user with the `AUTH_DEFAULT_ROLE` role (default `AUTHENTICATED`) — sensible behind Cloudflare Access, which already gates who reaches the app.

### Cloudflare Access allowlist sync

When the app sits behind Cloudflare Access with an e-mail allowlist policy, invites keep that policy in sync: set `CF_ACCOUNT_ID` and `CF_API_TOKEN` (API token scoped to *Account · Access: Apps and Policies · Edit*), optionally `CF_ACCESS_APP_DOMAIN` (defaults to `PUBLIC_URL`'s host) and `CF_ACCESS_POLICY_NAME` (default `allowlist`). The server finds the Access application by domain, reads the named allow policy and adds/removes `email` rules in its include list (read-modify-write, serialized in-process); other rules in the policy are kept. `GET /api/users/access` returns the current list, which the users table uses for the "Access" column. Without these variables invites still create the user and send the e-mail.
### Roles and permissions

Same model as the engenhariainversa CMS: a **role** is a named set of permissions, a **permission** is one `resource:action` grant (`create` / `read` / `update` / `delete`), roles flagged `is_admin` bypass every check, and system roles cannot be deleted. Resources: `machines`, `projects`, `terminals`, `tasks`, `notes`, `tickets`, `integrations`, `ai_accounts`, `hardware`, `waitlist`, `users`, `roles`.

- System roles: **ADMIN** (everything), **MANAGER** (the workspace plus the AI accounts, hardware and waitlist tabs, read-only users) and **AUTHENTICATED** (machines, projects, terminals, tasks, notes, tickets, integrations). Grants are editable in the app: sidebar → ⚙ Configurações → Usuários / Roles / Permissões (matrix resource × action).
- Every API plugin is registered under a resource; the auth hook derives the action from the HTTP method (GET read, POST create, PATCH/PUT update, DELETE delete) unless the route sets its own (`config: { resource, action }`). WebSockets need `terminals:read`. Grants are cached per role for 30 s and invalidated on change.
- The client gets `role_info` and a flat `permissions` list from `/api/auth/me` and hides tabs/links it cannot use; the server is the source of truth.
- Safety rails: the last admin cannot be demoted or deleted; you cannot delete yourself; roles with users cannot be deleted.

## Machines and projects

- **Local machine:** created automatically. Terminals run `tmux new-session -A -s <session> -c <cwd>` directly.
- **SSH machine:** in the sidebar, "+ machine" → type SSH, host, user and port. The form lists the setup steps per OS (enable the SSH server, install tmux, authorize termhub's key with a ready-to-paste command, find the IP) and has a **Test connection** button (`POST /api/machines/test`) that explains failures in plain words: SSH server off (connection refused), wrong IP (unreachable / timeout), key not authorized (permission denied), changed host key, or tmux missing. Terminals run `ssh -tt ... "tmux new-session -A -s <session> -c '<cwd>'"`.
- **Project:** hover the machine and click "+". Enter a name and the absolute directory on the target machine — or click "Browse…" to navigate the machine's folders: the browser lists disks/mounts (with free space, via `df`) and the home directory as shortcuts, lets you filter and show hidden folders, and fills the project name with the chosen folder (`GET /api/machines/:id/fs?path=`). "+ New folder" creates a subfolder in the current folder (`POST /api/machines/:id/fs/mkdir`). On save, the server checks the folder on the machine and resolves `~` to the absolute path; with "create the folder if it doesn't exist" checked it runs `mkdir -p`; unchecked, it refuses with an error instead of letting tmux fall back to the home directory.
- **Sidebar:** the `«` button at the top collapses the sidebar to a narrow rail to give the terminal more room (`»` expands it back); the choice is saved in the browser.
- **Tabs:** `⌘T` new, double-click renames, `⌘W` closes (with confirmation — kills the tmux session), `⌘1..9` switches. Since some browsers capture `⌘T`/`⌘W`, `Ctrl+Shift+T`/`Ctrl+Shift+W` work as alternatives.
- **Copy:** selecting text copies it automatically on mouse release ("Copied" notice in the status bar). When the running program enables mouse tracking (Claude Code, vim, htop…), the drag goes to it; hold `⌥` (Mac) or `Shift` (Linux/Windows) while dragging to select — the status bar shows when this is active.
- **Attach files:** drop files on the terminal, or `Cmd+V` with an image or files on the clipboard, to upload them to `~/.cache/termhub/paste/` on the tab's machine (up to 20 MB each; files older than 7 days are deleted on each new upload; original names kept, sanitized; images get their real extension) and paste the paths into the terminal — for Claude Code it is the same as attaching the file; the status bar shows progress. Plain text still pastes normally.
- tmux sessions are named `termhub-<project_id>-<tab_id>`; you can attach from outside with `tmux attach -t <name>`.

## Project management

Each project has internal navigation: **Terminals | Tasks | Notes | Settings**.

- **Tasks:** kanban with four columns (Backlog / To do / Doing / Done), drag and drop between columns and to reorder, quick create at the top of each column (Enter), double-click renames, click opens title/description/status/delete. The open-task counter shows in the sidebar next to the project. The `external_ref` field (JSON) is reserved for integrations (GitHub/Jira/Linear).
- **Notes:** one markdown note per project, with preview (GFM), edit / side-by-side / preview modes and debounced autosave (⌘S forces it).
- **Dashboard** (home): active projects with machine (online/offline), tasks in "Doing", total open tasks and last terminal access — ordered by most recent terminal.
- **Settings:** rename, edit `cwd`, description, status (active/paused/archived) and delete (ends the tabs' tmux sessions). In the sidebar, hovering a project shows ✎ (opens Settings) and ✕ (removes the project from the list — the folder on the machine is not touched).

## Hardware tab

The home page's **Hardware** tab shows a machine's CPU usage and load, RAM and swap, disks with free space, temperatures (Linux sensors), GPU (when `nvidia-smi` exists) and the top processes, refreshed every 5 s while the tab is visible. Pick any registered machine; the termhub host is the default. Data comes from a portable `sh` script run over the same local/SSH channel as the terminals (`GET /api/machines/:id/hardware`). macOS exposes no temperature sensors without extra tools. Shown to roles granted `hardware:read` (admins and, by default, managers).

## Cloud waitlist

The landing page (PT/EN, switch in the header, `?lang=pt|en` for links) has a **termhub Cloud** section with a waitlist form: first and last name, e-mail, phone (country code, area code, number) and optional LinkedIn/GitHub. Entries go to the `waitlist_entries` table through `POST /api/waitlist`, a public route (rate-limited per IP: 30 attempts and 5 sign-ups per hour, honeypot field, e-mail de-duplicated). The proxy forwards `termhub.dev/api/waitlist` to the app so the form is same-origin and outside Cloudflare Access. Sign-ups are listed on the home page's **Waitlist** tab (filter, CSV export, remove) via `GET/DELETE /api/waitlist`. Shown to roles granted `waitlist:read`.

## AI accounts (usage limits)

The home page has a second tab, **Contas de IA**, that shows the rate-limit windows of your AI subscriptions (Claude, ChatGPT, Gemini) with utilization bars and reset countdowns, refreshed every minute.

- No token is stored in termhub. Each account points at a **machine** where the provider's CLI is signed in; on every read the server fetches the CLI credential from that machine (over the same local/SSH channel the terminals use), calls the provider's usage endpoint, and keeps only the percentages. The token is never logged or sent to the browser.
- **Claude:** Claude Code login (`~/.claude/.credentials.json` on Linux, the "Claude Code-credentials" keychain item on macOS). For a second account (e.g. a Claude Enterprise seat), sign in once with `CLAUDE_CONFIG_DIR=~/.claude-work claude` and set that directory in the account's *config dir*.
- **ChatGPT:** Codex CLI login (`~/.codex/auth.json`, "Sign in with ChatGPT"). **Gemini:** Gemini CLI login (`~/.gemini/oauth_creds.json`, Google account). API-key logins have no subscription limits to show.
- The usage endpoints are the ones the CLIs themselves use for `/usage`, `/status` and `/stats`; they are not documented by the providers and may change. Failures show the provider's answer on the card so the adapter can be fixed.
- Routes: `GET/POST /api/ai-accounts`, `PATCH/DELETE /api/ai-accounts/:id`, `GET /api/ai-accounts/usage?refresh=1` (60 s cache).

## Integrations and project Setup

- **Integrations** (sidebar → ⚙ Integrations): credentials for **GitHub** (token), **Linear** (API key) and **Jira** (URL + e-mail + API token). Secrets encrypted with `ENCRYPTION_KEY` (AES-256-GCM); the "Test" button validates and lists teams/projects/repos.
- **Setup** (project tab): repository (GitHub integration, `owner/repo`, base branch, branch pattern, draft PR), **tickets** (Linear/Jira/GitHub source + scope + filter + auto sync), **runner** (machine where automation runs, cwd, setup command, worktree), **agent** (command, plugins, model), **verification** (iOS/web screenshot or command) and **approvals** (each decision: ask on the dashboard or automatic).
- **Tickets** (project tab): the sync (`POST /api/projects/:id/tickets/sync` or automatic) feeds a **ticket list per integration** — nothing enters the board on its own. You select the ones you want and click "Send to backlog": they become tasks in the **Backlog** column with `external_ref` (`{provider, id, identifier, url, state}`). Later syncs only refresh the mirror of the external state; the column and title on the kanban are yours. Deleting the task returns the ticket to the list.
- **Nothing goes back to Linear/Jira/GitHub automatically**: on the task (⋯) the "Update on Linear/Jira" button pushes the current column to the provider (Linear: state of the matching type in the team; Jira: transition by `statusCategory`; GitHub: open/closed). The card warns when the external state differs from the column.
- **Terminal per task**: "Open terminal for this task" creates a tmux tab named after the ticket and links it (`tasks.tab_id`); the card shows `▮_` with a direct link to the tab. That is where the agent run will show up.
- Machine status detects the OS and tools (`claude`, `gh`, `git`, `node`, `xcodebuild`, `adb`…) — used to pick the runner.

## Environment variables

See [.env.example](.env.example). Main ones:

| Variable | Description |
| --- | --- |
| `AUTH_MODE` | `app`, `cloudflare`, `disabled` (dev) or the combination `app,cloudflare` |
| `PUBLIC_URL` | public URL (secure cookies and OAuth redirect) |
| `DATABASE_URL` | Postgres (`postgresql://user:pass@host:5432/db`) |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`EMAIL_FROM` | login code and invite delivery |
| `CF_ACCOUNT_ID`/`CF_API_TOKEN`/`CF_ACCESS_APP_DOMAIN`/`CF_ACCESS_POLICY_NAME` | Cloudflare Access allowlist sync on invite/delete (optional) |
| `BIND_ADDR` | (compose) host IP that publishes Mailpit's UI port; the prod app has no host port of its own (proxy nginx only) |
| `ENCRYPTION_KEY` | base64 of 32 bytes (`openssl rand -base64 32`) for integration secrets |
| `TMUX_PATH` | path to tmux (useful as a service, minimal PATH) |
| `LOCAL_SHELL` | shell inside local tmux (default `$SHELL`) |

## Structure

npm workspaces monorepo: `apps/server` (`@termhub/server`), `apps/web` (`@termhub/web`) and `apps/landing` (`@termhub/landing`, the static site at termhub.dev). Run a workspace script with `npm run <script> -w @termhub/<name>`.

```
apps/landing       marketing site (Vite + React), built into a static nginx image (apps/landing/Dockerfile)
apps/server/prisma schema.prisma + migrations (npm run prisma:migrate -- --name <name>)
apps/server/src
  auth/          providers (password, google, cloudflare), session, CSRF, middleware
  db/            Prisma client + repositories (the rest of the app never imports Prisma)
  email/         mailer (SMTP/console) and templates
  cli/           create-user
  routes/        REST routes (zod on every input)
  terminal/      exec on machines (local/ssh), PTY, WebSocket
apps/web/src
  components/    Sidebar, TabBar, Terminal (xterm), forms
  pages/         Login, Home, Project
  lib/           api client, auth/data providers, WS connection with backoff
```

## Security

- `httpOnly` + `SameSite=Lax` cookies; opaque session token, only its hash is stored
- CSRF double-submit (`termhub_csrf` + `x-csrf-token` header) on every mutation
- Progressive login lockout (per e-mail and per IP)
- WebSocket: authentication on upgrade + `Origin` check
- Terminal content is never logged

## Support

termhub is built in the open, evenings and weekends. If it saves you time, a coffee keeps the lights on:

<a href="https://buymeacoffee.com/pedrogoiania"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40"></a>

## License

[MIT](LICENSE) © Pedro Duarte
