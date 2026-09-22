/**
 * Monitor hooks: the small POSIX script under ~/.termhub/bin that forwards Claude Code / Codex /
 * Cursor CLI hook payloads to termhub, and the pure merge/strip of the config files that make the
 * tools call it. Shared by the server (ssh/local machines, written through `sh -s`) and the
 * agent (`hooks.install` RPC, written with node:fs on the machine itself).
 */

import { shellQuote } from './shell.js';

export const HOOK_SCRIPT_REL = '.termhub/bin/termhub-hook';
export const HOOK_ENV_REL = '.termhub/hook.env';
/** Substring that marks an entry as ours in settings.json / config.toml. */
export const HOOK_MARK = 'termhub-hook';

/** Claude Code's default config dir; an account can use another one (CLAUDE_CONFIG_DIR). */
export const CLAUDE_DEFAULT_DIR = '~/.claude';

/**
 * The Claude config dirs to hook, as "~/x" or "/abs": the default first, then each account's
 * own dir once (a bare "x" is taken as "~/x"). The home itself and odd paths are dropped.
 */
export function claudeConfigDirs(accountDirs: readonly (string | null | undefined)[]): string[] {
  const out = [CLAUDE_DEFAULT_DIR];
  for (const raw of accountDirs) {
    let d = (raw ?? '').trim().replace(/\/+$/, '');
    if (!d || d === '~' || /[\0\n\r]/.test(d)) continue;
    if (!d.startsWith('~/') && !d.startsWith('/')) d = `~/${d}`;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** "~/x" on a machine whose $HOME is `home`; absolute paths stay as they are. */
export function expandHome(dir: string, home: string): string {
  return dir.startsWith('~/') ? `${home}/${dir.slice(2)}` : dir;
}

/** Claude Code hook events we subscribe to (see the server's monitor/state.ts for what each one means). */
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'] as const;

/**
 * Cursor CLI hook events we subscribe to (~/.cursor/hooks.json; see the server's monitor/state.ts).
 * No hook that answers a permission check: `beforeShellExecution`, `beforeMCPExecution`,
 * `beforeReadFile` and `preToolUse` can allow or deny, and ours must never be in that position.
 * `beforeSubmitPrompt` is blocking too — its stdout can cancel the prompt — and is taken on purpose:
 * it is the only signal that a new turn started. The script prints nothing, which Cursor reads as
 * "go on" (checked against cursor-agent 2026.09.18; hook-script.test.ts keeps stdout empty).
 */
export const CURSOR_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'afterAgentResponse', 'stop', 'sessionEnd'] as const;

/** The script itself. Reads the hook JSON (stdin for Claude and Cursor, argv for Codex), tags it with the tmux session and posts it in the background. */
export const HOOK_SCRIPT = `#!/bin/sh
# termhub monitor hook — installed by termhub; forwards Claude Code / Codex / Cursor CLI hook
# events to termhub tagged with the tmux session, so the app knows which tab is waiting for you.
# Safe to delete (also remove the entries in ~/.claude/settings.json, ~/.codex/config.toml and
# ~/.cursor/hooks.json).
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
# Tool calls: only the tool's name travels (never its input), and only when it changed since the
# last one for this session — twenty edits in a row are one request. The marker is per tmux
# session, under TMPDIR, with the session name reduced to filename-safe characters.
MARK="\${TMPDIR:-/tmp}/termhub-hook-$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_-' '_')"
case "$EVENT" in
  *'"hook_event_name":"PreToolUse"'*|*'"hook_event_name": "PreToolUse"'*)
    # The event's own tool name is the FIRST "tool_name" of the payload (Claude Code serialises it
    # before tool_input), so the shortest prefix is cut — a "tool_name" nested in a tool's input
    # must not win. Only letters, digits, "_", "." and "-" are posted (a bare Claude Code tool name,
    # or an MCP tool name such as mcp__claude-in-chrome__click): anything else (a number, a name with
    # a quote or a backslash) is dropped rather than sent — those are the only characters the
    # hand-built JSON body below cannot survive as-is.
    REST=\${EVENT#*'"tool_name"'}
    [ "$REST" != "$EVENT" ] || exit 0
    REST=\${REST#*'"'}
    NAME=\${REST%%'"'*}
    case "$NAME" in '' | *[!A-Za-z0-9_.-]*) exit 0 ;; esac
    [ "$(cat "$MARK" 2>/dev/null)" = "$NAME" ] && exit 0
    printf '%s' "$NAME" 2>/dev/null > "$MARK"
    EVENT=$(printf '{"hook_event_name":"PreToolUse","tool_name":"%s"}' "$NAME")
    ;;
  # A new turn starts fresh, and so does an answered notification: a permission prompt takes the tab
  # out of working, and the tool the person approves is the same one that set the marker, so without
  # this reset the retry is suppressed and nothing says the tab is working again.
  *'"hook_event_name":"SessionStart"'*|*'"hook_event_name": "SessionStart"'*|*'"hook_event_name":"UserPromptSubmit"'*|*'"hook_event_name": "UserPromptSubmit"'*|*'"hook_event_name":"Notification"'*|*'"hook_event_name": "Notification"'*)
    rm -f "$MARK"
    ;;
esac
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
    const entry: HookEntry = { hooks: [{ type: 'command', command: `${scriptPath} claude`, timeout: 10 } as { type: string; command: string }] };
    // A tool event's entry is filtered by tool name; '*' says every tool explicitly (so would no matcher).
    if (event === 'PreToolUse') entry.matcher = '*';
    others.push(entry);
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

type CursorEntry = { command?: unknown };

const isOurCursorEntry = (e: CursorEntry) => !!e && typeof e === 'object' && typeof e.command === 'string' && e.command.includes(HOOK_MARK);

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Merges our entries into Cursor's ~/.cursor/hooks.json (`{ version, hooks: { event: [{ command }] } }`); keeps everything else. Throws on a file that is not a JSON object. */
export function mergeCursorHooks(current: string, scriptPath: string): string {
  let file: Record<string, unknown> = {};
  if (current.trim()) {
    const parsed = asObject(JSON.parse(current) as unknown);
    if (!parsed) throw new Error('~/.cursor/hooks.json não é um objeto JSON');
    file = parsed;
  }
  // a `hooks` we cannot read would be replaced by ours alone, and uninstall could not give it back
  if (file.hooks != null && !asObject(file.hooks)) throw new Error('~/.cursor/hooks.json: o campo "hooks" não é um objeto');
  const hooks = asObject(file.hooks) ?? {};
  for (const event of CURSOR_HOOK_EVENTS) {
    const others = ((Array.isArray(hooks[event]) ? hooks[event] : []) as CursorEntry[]).filter((e) => !isOurCursorEntry(e));
    others.push({ command: `${scriptPath} cursor` });
    hooks[event] = others;
  }
  return `${JSON.stringify({ ...file, version: typeof file.version === 'number' ? file.version : 1, hooks }, null, 2)}\n`;
}

/** Removes our entries; drops events left empty, and `hooks` when nothing is left. Leaves anything that is not a JSON object alone. */
export function stripCursorHooks(current: string): string {
  if (!current.trim()) return current;
  const file = asObject(JSON.parse(current) as unknown);
  if (!file) return current;
  const hooks = asObject(file.hooks);
  if (hooks) {
    for (const key of Object.keys(hooks)) {
      if (!Array.isArray(hooks[key])) continue;
      const kept = (hooks[key] as CursorEntry[]).filter((e) => !isOurCursorEntry(e));
      if (kept.length) hooks[key] = kept;
      else delete hooks[key];
    }
    if (Object.keys(hooks).length === 0) delete file.hooks;
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}
