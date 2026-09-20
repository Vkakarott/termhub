# @termhub/agent

A small CLI that runs on your own machine (macOS or Linux) and connects it to a termhub server,
so its terminals are reachable from the termhub web app over a single outbound WebSocket. It
attaches PTY sessions to `tmux`, so a terminal survives the agent restarting or your laptop
sleeping.

## Install

```bash
npm i -g @termhub/agent && termhub-agent --version
```

Requires Node 20+ and `tmux` on the machine you're pairing.

## Connect

```bash
termhub-agent connect --url https://app.termhub.dev
```

You'll be prompted to paste an agent token generated from the termhub web app (Machines → Add
machine). `--token <token>` and the `TERMHUB_URL`/`TERMHUB_TOKEN` environment variables work too,
for non-interactive setups. On success the pairing is saved and the command exits; start the agent
with `termhub-agent service install` (background) or `termhub-agent run` (foreground).

## Run as a background service

```bash
termhub-agent service install
```

Installs a per-user service (a `launchd` agent on macOS, a `systemd --user` unit on Linux) that
starts the agent at login/boot and restarts it on failure. `termhub-agent service status` and
`termhub-agent service uninstall` manage it afterwards. On Linux, run
`loginctl enable-linger $USER` once so the service keeps running after you log out.

The service is deliberately kept apart from the tmux server that holds your terminals: on Linux
the unit sets `KillMode=process`, so restarting or updating the agent signals only the agent
itself and leaves tmux — and whatever is running inside it — alone, and the agent reattaches to
the existing sessions when it comes back (macOS needs nothing: launchd does not follow tmux once
it daemonises). A unit installed by an older agent is rewritten to the current template the first
time the new agent starts.

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

## Troubleshooting

- **`termhub-agent: command not found` right after `npm i -g`**:
  - **asdf**: asdf only creates shims for new global binaries after `asdf reshim nodejs` — run it once
    and the command appears (same after every `npm i -g` of a new package).
  - Otherwise npm's global bin directory is not on your `PATH` (common with Node from `n`, Volta, a
    custom `npm config set prefix`, or distro packages): `export PATH="$(npm prefix -g)/bin:$PATH"`
    and add it to `~/.zshrc`/`~/.bashrc`.
  - Or skip the PATH entirely: `npx -y @termhub/agent connect --url … --token …`.

- **Terminals fail to open with `posix_spawnp failed.`** (visible in `~/.termhub/agent.log`): node-pty's
  prebuilt `spawn-helper` lost its exec bit — npm 11 skips the postinstall that sets it unless the
  package is approved. The agent repairs this itself on startup and in `termhub-agent doctor`; if the
  file is not writable by your user, `doctor` prints the exact `chmod +x` to run.
