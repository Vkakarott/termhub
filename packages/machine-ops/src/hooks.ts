/**
 * Monitor hooks: the small POSIX script under ~/.termhub/bin that forwards Claude Code / Codex
 * hook payloads to termhub, and the pure merge/strip of the two config files that make the
 * tools call it. Shared by the server (ssh/local machines, written through `sh -s`) and the
 * agent (`hooks.install` RPC, written with node:fs on the machine itself).
 */

import { shellQuote } from './shell.js';

export const HOOK_SCRIPT_REL = '.termhub/bin/termhub-hook';
export const HOOK_ENV_REL = '.termhub/hook.env';
/** Substring that marks an entry as ours in settings.json / config.toml. */
export const HOOK_MARK = 'termhub-hook';

/** Claude Code hook events we subscribe to (see the server's monitor/state.ts for what each one means). */
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const;

/** The script itself. Reads the hook JSON (stdin for Claude, argv for Codex), tags it with the tmux session and posts it in the background. */
export const HOOK_SCRIPT = `#!/bin/sh
# termhub monitor hook — installed by termhub; forwards Claude Code / Codex hook events to
# termhub tagged with the tmux session, so the app knows which tab is waiting for you.
# Safe to delete (also remove the entries in ~/.claude/settings.json and ~/.codex/config.toml).
TOOL="\${1:-claude}"
[ -f "$HOME/${HOOK_ENV_REL}" ] || exit 0
. "$HOME/${HOOK_ENV_REL}"
[ -n "$TERMHUB_HOOK_URL" ] && [ -n "$TERMHUB_HOOK_TOKEN" ] || exit 0
[ -n "$TMUX_PANE" ] || exit 0
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
SESSION=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || exit 0
[ -n "$SESSION" ] || exit 0
if [ "$TOOL" = codex ]; then EVENT="$2"; else EVENT=$(cat 2>/dev/null); fi
[ -n "$EVENT" ] || EVENT='{}'
{ printf '{"tool":"%s","session":"%s","event":' "$TOOL" "$SESSION"; printf '%s' "$EVENT"; printf '}'; } |
  curl -s -m 5 -o /dev/null -X POST "$TERMHUB_HOOK_URL" \\
    -H "authorization: Bearer $TERMHUB_HOOK_TOKEN" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 &
exit 0
`;

/** Body of ~/.termhub/hook.env: sourced by the script, so the values are single-quoted for sh. */
export function hookEnvFile(hooksUrl: string, token: string): string {
  return `TERMHUB_HOOK_URL=${shellQuote(hooksUrl)}\nTERMHUB_HOOK_TOKEN=${shellQuote(token)}\n`;
}

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };

const isOurs = (e: HookEntry) => !!e && typeof e === 'object' && Array.isArray(e.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARK));

/** Merges our entries into Claude Code's settings.json; keeps everything else. Throws on a file that is not a JSON object. */
export function mergeClaudeSettings(current: string, scriptPath: string): string {
  let settings: Record<string, unknown> = {};
  if (current.trim()) {
    const parsed = JSON.parse(current) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('~/.claude/settings.json não é um objeto JSON');
    settings = parsed as Record<string, unknown>;
  }
  const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {}) as Record<string, unknown>;
  for (const event of CLAUDE_HOOK_EVENTS) {
    const list = (Array.isArray(hooks[event]) ? hooks[event] : []) as HookEntry[];
    const others = list.filter((e) => !isOurs(e));
    others.push({ hooks: [{ type: 'command', command: `${scriptPath} claude`, timeout: 10 } as { type: string; command: string }] });
    hooks[event] = others;
  }
  settings.hooks = hooks;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Removes our entries; drops `hooks` keys left empty. Leaves anything that is not a JSON object alone. */
export function stripClaudeSettings(current: string): string {
  if (!current.trim()) return current;
  const parsed = JSON.parse(current) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return current;
  const settings = parsed as Record<string, unknown>;
  const hooks = settings.hooks;
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    const h = hooks as Record<string, unknown>;
    for (const key of Object.keys(h)) {
      if (!Array.isArray(h[key])) continue;
      const kept = (h[key] as HookEntry[]).filter((e) => !isOurs(e));
      if (kept.length) h[key] = kept;
      else delete h[key];
    }
    if (Object.keys(h).length === 0) delete settings.hooks;
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Codex reads `notify = [...]` from config.toml: replaces an existing line or prepends ours. */
export function mergeCodexConfig(current: string, scriptPath: string): string {
  const line = `notify = [${JSON.stringify(scriptPath)}, "codex"]`;
  const lines = current.split('\n');
  const idx = lines.findIndex((l) => /^\s*notify\s*=/.test(l));
  if (idx !== -1) lines[idx] = line;
  else lines.unshift(line);
  const out = lines.join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

export function stripCodexConfig(current: string): string {
  const lines = current.split('\n').filter((l) => !(/^\s*notify\s*=/.test(l) && l.includes(HOOK_MARK)));
  return lines.join('\n');
}
