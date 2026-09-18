import type { Machine } from '../db/repositories/types.js';
import { REMOTE_PATH_PREFIX, runOnMachine, runOnMachineWithInput, shellQuote } from '../terminal/machine-exec.js';

/**
 * Installs the monitor hooks on a machine: a small POSIX script under ~/.termhub/bin that
 * forwards the tools' hook payloads to termhub, and the entries that make Claude Code and
 * Codex call it. Everything is written by one `sh -s` fed through stdin; the Claude settings
 * are read first and merged here (JSON), so nothing the user configured is lost.
 */

export const HOOK_SCRIPT_REL = '.termhub/bin/termhub-hook';
export const HOOK_ENV_REL = '.termhub/hook.env';
const MARK = 'termhub-hook';

/** Claude Code hook events we subscribe to (see monitor/state.ts for what each one means). */
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

export interface HookInstallReport {
  home: string;
  claude: 'installed' | 'skipped';
  codex: 'installed' | 'skipped';
  hooks_url: string;
}

/** POSIX `sh -s` on the machine: local and remote take the same script on stdin. */
function shOnMachine(machine: Machine, script: string, timeoutMs = 20_000) {
  return runOnMachineWithInput(machine, { file: 'sh', args: ['-s'] }, `${REMOTE_PATH_PREFIX}sh -s`, Buffer.from(script, 'utf8'), timeoutMs);
}

const SEP = '__TERMHUB_SEP__';

/** $HOME plus the current Claude settings and Codex config (empty when absent). */
async function readMachineConfigs(machine: Machine): Promise<{ home: string; claudeSettings: string; codexConfig: string; hasCodex: boolean }> {
  const r = await runOnMachine(
    machine,
    { file: 'sh', args: ['-c', `printf '%s\\n${SEP}\\n' "$HOME"; cat "$HOME/.claude/settings.json" 2>/dev/null; printf '\\n${SEP}\\n'; [ -d "$HOME/.codex" ] && echo yes || echo no; printf '\\n${SEP}\\n'; cat "$HOME/.codex/config.toml" 2>/dev/null`] },
    `printf '%s\\n${SEP}\\n' "$HOME"; cat "$HOME/.claude/settings.json" 2>/dev/null; printf '\\n${SEP}\\n'; [ -d "$HOME/.codex" ] && echo yes || echo no; printf '\\n${SEP}\\n'; cat "$HOME/.codex/config.toml" 2>/dev/null`,
  );
  if (r.code !== 0) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : 'Não foi possível ler a configuração da máquina');
  const [home = '', claudeSettings = '', codex = '', codexConfig = ''] = r.stdout.split(`\n${SEP}\n`);
  if (!home.trim().startsWith('/')) throw new Error('Não foi possível descobrir o $HOME da máquina');
  return { home: home.trim(), claudeSettings, codexConfig, hasCodex: codex.trim() === 'yes' };
}

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };

/** Merges our entries into Claude Code's settings.json; keeps everything else. Exported for the unit test. */
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

/** Removes our entries; drops `hooks` keys left empty. Exported for the unit test. */
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

const isOurs = (e: HookEntry) => !!e && typeof e === 'object' && Array.isArray(e.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(MARK));

/** Codex reads `notify = [...]` from config.toml: replaces an existing line or prepends ours. Exported for the unit test. */
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
  const lines = current.split('\n').filter((l) => !(/^\s*notify\s*=/.test(l) && l.includes(MARK)));
  return lines.join('\n');
}

/** Quoted heredoc: the body is taken literally; the delimiter never appears in what we write. */
const heredoc = (path: string, body: string) => `cat > ${path} <<'__TERMHUB_EOF__'\n${body.endsWith('\n') ? body : `${body}\n`}__TERMHUB_EOF__\n`;

export async function installHooks(machine: Machine, token: string, hooksUrl: string): Promise<HookInstallReport> {
  if (!/^https?:\/\/[^\s'"]+$/.test(hooksUrl)) throw new Error('HOOKS_URL inválida');
  const { home, claudeSettings, codexConfig, hasCodex } = await readMachineConfigs(machine);
  const scriptPath = `${home}/${HOOK_SCRIPT_REL}`;
  const mergedClaude = mergeClaudeSettings(claudeSettings, scriptPath);
  const mergedCodex = hasCodex ? mergeCodexConfig(codexConfig, scriptPath) : null;

  const q = shellQuote;
  const script = [
    'set -e',
    `mkdir -p "$HOME/.termhub/bin" "$HOME/.claude"`,
    `umask 077`,
    heredoc(q(`${home}/${HOOK_ENV_REL}`), `TERMHUB_HOOK_URL=${q(hooksUrl)}\nTERMHUB_HOOK_TOKEN=${q(token)}`),
    `umask 022`,
    heredoc(q(scriptPath), HOOK_SCRIPT),
    `chmod 755 ${q(scriptPath)}`,
    heredoc(q(`${home}/.claude/settings.json.termhub-new`), mergedClaude),
    `mv ${q(`${home}/.claude/settings.json.termhub-new`)} ${q(`${home}/.claude/settings.json`)}`,
    ...(mergedCodex !== null
      ? [heredoc(q(`${home}/.codex/config.toml.termhub-new`), mergedCodex), `mv ${q(`${home}/.codex/config.toml.termhub-new`)} ${q(`${home}/.codex/config.toml`)}`]
      : []),
    'echo ok',
  ].join('\n');
  const r = await shOnMachine(machine, script);
  if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : `Instalação falhou: ${r.stderr.trim().split('\n').pop() || 'erro desconhecido'}`);
  return { home, claude: 'installed', codex: mergedCodex !== null ? 'installed' : 'skipped', hooks_url: hooksUrl };
}

export async function uninstallHooks(machine: Machine): Promise<void> {
  const { home, claudeSettings, codexConfig, hasCodex } = await readMachineConfigs(machine);
  const q = shellQuote;
  let stripped: string | null = null;
  try {
    stripped = claudeSettings.trim() ? stripClaudeSettings(claudeSettings) : null;
  } catch {
    stripped = null; // unreadable JSON: leave the file alone
  }
  const script = [
    'set -e',
    `rm -f ${q(`${home}/${HOOK_SCRIPT_REL}`)} ${q(`${home}/${HOOK_ENV_REL}`)}`,
    ...(stripped !== null ? [heredoc(q(`${home}/.claude/settings.json.termhub-new`), stripped), `mv ${q(`${home}/.claude/settings.json.termhub-new`)} ${q(`${home}/.claude/settings.json`)}`] : []),
    ...(hasCodex && codexConfig.includes(MARK)
      ? [heredoc(q(`${home}/.codex/config.toml.termhub-new`), stripCodexConfig(codexConfig)), `mv ${q(`${home}/.codex/config.toml.termhub-new`)} ${q(`${home}/.codex/config.toml`)}`]
      : []),
    'echo ok',
  ].join('\n');
  const r = await shOnMachine(machine, script);
  if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : `Remoção falhou: ${r.stderr.trim().split('\n').pop() || 'erro desconhecido'}`);
}
