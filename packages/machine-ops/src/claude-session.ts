import { configDirPrefix } from './ai-credentials.js';
import { shellQuote } from './shell.js';

/**
 * Moving a Claude Code session to another account of the same machine (spec 2026-09-26 account swap).
 * A session lives in `<config dir>/projects/<cwd slug>/<session id>.jsonl` (plus an optional
 * `<session id>/` directory); `claude --resume <id>` only finds sessions under its own config dir, so
 * the transcript is symlinked into the target account — both accounts then write the same file.
 */
export const CLAUDE_LINK_STATUSES = ['linked', 'same_account', 'no_transcript', 'no_config_dir', 'conflict'] as const;
export type ClaudeLinkStatus = (typeof CLAUDE_LINK_STATUSES)[number];

export const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSCRIPT_MAX = 1024;

export function isClaudeSessionId(v: unknown): v is string {
  return typeof v === 'string' && CLAUDE_SESSION_ID_RE.test(v);
}

/** An absolute `<dir>/projects/<slug>/<sessionId>.jsonl`, no `..` segment, no control character. */
export function isClaudeTranscriptPath(p: unknown, sessionId: string): p is string {
  if (typeof p !== 'string' || p.length > TRANSCRIPT_MAX || !p.startsWith('/')) return false;
  if (/[\0-\x1f\x7f]/.test(p)) return false;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.')) return false;
  const n = parts.length;
  return n >= 5 && parts[n - 1] === `${sessionId}.jsonl` && parts[n - 2] !== '' && parts[n - 3] === 'projects';
}

/**
 * Prints one of CLAUDE_LINK_STATUSES and exits 0. Never deletes a file: an entry that already is the
 * same file (`-ef`, e.g. swapping back through the other account's symlink) is fine, and a regular file
 * whose content is an older prefix of the transcript (a copy left by an earlier pass of the session
 * through this account) is renamed to `<id>.jsonl.termhub-old-<epoch>` and replaced by the link;
 * anything else is `conflict`. A symlink that points nowhere is replaced (it holds no data). The
 * source's own config dir is compared with the target by physical path, so an account registered as
 * `~/x` and a transcript under `/home/me/x` are the same account.
 *
 * When the transcript is no longer where the hook said, it is looked up by session id in the other
 * project dirs of the same account (the newest file wins): leaving a session whose worktree had no changes removes the
 * worktree, and Claude Code moves the transcript to the main repository's project dir (TER-587). The
 * link then goes into that project dir of the target account, which is where `claude --resume` run
 * from the tab's shell looks.
 */
export function claudeLinkScript(transcriptPath: string, sessionId: string, configDir: string | null): string {
  return [
    configDirPrefix(configDir, '.claude'),
    `SRC=${shellQuote(transcriptPath)}; SID=${shellQuote(sessionId)}`,
    'SLUGDIR=$(dirname "$SRC"); SRCROOT=$(dirname "$(dirname "$SLUGDIR")")',
    'if [ ! -f "$SRC" ]; then',
    '  SRC=; for F in "$SRCROOT"/projects/*/"$SID.jsonl"; do [ -f "$F" ] || continue; if [ -z "$SRC" ] || [ "$F" -nt "$SRC" ]; then SRC=$F; fi; done',
    '  [ -n "$SRC" ] || { echo no_transcript; exit 0; }',
    '  SLUGDIR=$(dirname "$SRC")',
    'fi',
    'SLUG=$(basename "$SLUGDIR")',
    '[ -d "$D" ] || { echo no_config_dir; exit 0; }',
    'if [ "$(cd "$SRCROOT" && pwd -P)" = "$(cd "$D" && pwd -P)" ]; then echo same_account; exit 0; fi',
    'mkdir -p "$D/projects/$SLUG" 2>/dev/null || { echo no_config_dir; exit 0; }',
    'T="$D/projects/$SLUG/$SID.jsonl"',
    'if [ -L "$T" ] && [ ! -e "$T" ]; then rm -f "$T"; fi',
    'if [ -e "$T" ]; then',
    '  if [ ! "$T" -ef "$SRC" ]; then',
    '    [ -f "$T" ] && [ ! -L "$T" ] || { echo conflict; exit 0; }',
    '    N=$(wc -c < "$T" | tr -d " "); M=$(wc -c < "$SRC" | tr -d " ")',
    '    [ "$N" -le "$M" ] && head -c "$N" "$SRC" | cmp -s - "$T" || { echo conflict; exit 0; }',
    '    mv -n "$T" "$T.termhub-old-$(date +%s)" 2>/dev/null && ln -s "$SRC" "$T" 2>/dev/null || { echo conflict; exit 0; }',
    '  fi',
    'else ln -s "$SRC" "$T" 2>/dev/null || { echo conflict; exit 0; }; fi',
    'if [ -d "$SLUGDIR/$SID" ] && [ ! -e "$D/projects/$SLUG/$SID" ] && [ ! -L "$D/projects/$SLUG/$SID" ]; then ln -s "$SLUGDIR/$SID" "$D/projects/$SLUG/$SID" 2>/dev/null; fi',
    'echo linked',
  ].join('\n');
}

export function parseClaudeLinkStatus(stdout: string): ClaudeLinkStatus | null {
  const words = stdout.split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if ((CLAUDE_LINK_STATUSES as readonly string[]).includes(words[i])) return words[i] as ClaudeLinkStatus;
  }
  return null;
}
