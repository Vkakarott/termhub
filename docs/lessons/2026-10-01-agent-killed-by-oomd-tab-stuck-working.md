---
symptom: "two tabs stay working for 40 min with only the shell prompt on screen; termhub-agent.service: systemd-oomd killed 6 process(es) in this unit"
tags: [monitor, agent, systemd, oomd, tmux, linux]
evidence: fixed
card: TER-643
agent: claude
date: 2026-10-01
---
## Cause

On 2026-10-01 at 05:48:35Z, two Claude Code sessions in jarvis tabs died together, mid-turn, with no
hook event. The screens fell back to the shell prompt; `list_tabs` kept saying `working`.

The user journal (`journalctl --user -u termhub-agent`) shows it: memory pressure on
`user@1000.service` stayed above systemd-oomd's limit (86% > 50% for more than 20 s), and oomd killed
two `tmux-spawn-*.scope` cgroups and then the whole `termhub-agent.service` cgroup
("systemd-oomd killed 6 process(es) in this unit", "Failed with result 'oom-kill'"). systemd restarted
the agent 3 s later.

The tab sessions die with the agent because the agent starts the tmux server, so the server and every
process in its panes (the tabs' Claude/Codex) live in the agent's cgroup. With `KillMode=process` a
normal stop or restart leaves them alone, but oomd kills the cgroup's processes, whatever the
`KillMode`. The cgroup was also a bigger target than it looked: 954 MB, almost all of it the tabs'
agents, not the agent itself.

Neither the hooks nor the TER-615 sweeper noticed: a killed CLI fires no `Stop`/`SessionEnd`, and the
sweeper only read Claude screens (prompt, spinner, dialog), so a shell prompt changed nothing.

## Fix

- Agent 0.14.0 answers `tmux.foreground`: whether the pane's own shell holds the terminal again
  (`ps -o tpgid=` of the pane pid equals the pane pid), shared script in
  `packages/machine-ops/src/pane-script.ts`.
- `monitor/stale-working.ts` asks it for every Claude or Codex tab working with no event for
  3 minutes. Shell in front (or a dead pane): the tab becomes `idle` with "Agente encerrado sem
  terminar o turno" (`AgentExited` event), and `chat/agent-exited.ts` opens a card in the project's
  chat offering the line that resumes the session (`claude --resume <id>` under the tab's account,
  else `claude --continue` / `codex resume --last`).
- Not fixed here: the tabs still share the agent's cgroup, so oomd under pressure can kill all of them
  at once. Moving the tmux server to its own scope (or each tab to its own) would contain that.

## How to check

`journalctl --user -u termhub-agent | grep -i oom` on the machine. After an agent dies, the server
log shows `monitor: agent exited without a hook` within about 4 minutes, the tab's last `tab_events`
row is `idle` with `{"event":"AgentExited"}`, and the project's chat shows the resume card.
