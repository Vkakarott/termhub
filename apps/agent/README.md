# @termhub/agent

A small CLI that runs on your own machine (macOS or Linux) and connects it to a termhub server,
so its terminals are reachable from the termhub web app over a single outbound WebSocket. It
attaches PTY sessions to `tmux`, so a terminal survives the agent restarting or your laptop
sleeping.

## Install

```bash
npm i -g @termhub/agent
```

Requires Node 20+ and `tmux` on the machine you're pairing.

## Connect

```bash
termhub-agent connect --url https://app.termhub.dev
```

You'll be prompted to paste an agent token generated from the termhub web app (Machines → Add
machine). `--token <token>` and the `TERMHUB_URL`/`TERMHUB_TOKEN` environment variables work too,
for non-interactive setups. On success the agent keeps running in the foreground until Ctrl-C.

## Run as a background service

```bash
termhub-agent service install
```

Installs a per-user service (a `launchd` agent on macOS, a `systemd --user` unit on Linux) that
starts the agent at login/boot and restarts it on failure. `termhub-agent service status` and
`termhub-agent service uninstall` manage it afterwards. On Linux, run
`loginctl enable-linger $USER` once so the service keeps running after you log out.

## Other commands

- `termhub-agent status` — shows the paired server, machine name and whether the agent can reach
  it right now.
- `termhub-agent disconnect` — removes the local config (`~/.termhub/config.json`); revoke the
  token from the termhub web app too.
- `termhub-agent doctor` — checks the local config, server reachability, `tmux`, `node-pty` and
  filesystem access to `$HOME`/`Documents`/`Desktop` (and every volume under `/Volumes` on
  macOS).

## macOS: Full Disk Access

macOS's TCC (Transparency, Consent and Control) can block the agent from listing folders such as
`~/Documents`, `~/Desktop` or an external volume, even though the agent process itself has no
special privileges. If `doctor` or `service install` reports this, grant the agent's Node binary
Full Disk Access: **Ajustes → Privacidade e Segurança → Acesso Total ao Disco**, then add the
`node` binary path `doctor` printed.
