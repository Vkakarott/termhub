/**
 * Finding the Claude config dirs of a machine on our own: the pure half of it.
 *
 * A person can run Claude Code with any CLAUDE_CONFIG_DIR (one shell alias per account is the
 * common shape), and only the dirs we hook ever report to termhub. Instead of asking the user to
 * register each path, the agent and the server collect them from the machine — the home's own
 * `.claude*` dirs and the CLAUDE_CONFIG_DIR assignments in the shell rc files — and feed them to
 * the same install as the registered ones. Listing and reading files is the caller's job; what is
 * here decides, without touching the disk, which dirs count.
 */

/** A dir of the machine's home, with the names of the files directly inside it. */
export interface HomeEntry {
  name: string;
  files: readonly string[];
}

/** Any of these inside a `.claude*` dir means Claude Code lives there, not that the name is a coincidence. */
const CLAUDE_MARKERS = ['settings.json', 'projects', '.credentials.json'];

/** `.claude`, `.claude-work`, `.claude_someone`: the config dir naming people actually use. */
const CLAUDE_DIR_NAME = /^\.claude[A-Za-z0-9._-]*$/;

/** The home dirs that are Claude config dirs, as "~/name", in the order they were listed. */
export function claudeDirsFromHome(entries: readonly HomeEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (!CLAUDE_DIR_NAME.test(entry.name)) continue;
    if (!entry.files.some((f) => CLAUDE_MARKERS.includes(f))) continue;
    const dir = `~/${entry.name}`;
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/** `CLAUDE_CONFIG_DIR=<value>` anywhere in a line, quoted or bare; fish writes it as `set -x CLAUDE_CONFIG_DIR <value>`. */
const ASSIGNMENT = /CLAUDE_CONFIG_DIR=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"';]*))/g;
const FISH_SET = /CLAUDE_CONFIG_DIR\s+(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"';]+))/g;

/** "$HOME/x" and a bare "x" both mean "~/x"; a value we cannot expand, or the home itself, means nothing to hook. */
function normalize(raw: string): string | null {
  let value = raw.trim().replace(/\/+$/, '');
  value = value.replace(/^\$\{?HOME\}?(?=\/|$)/, '~');
  if (!value || value === '~' || value.includes('$') || /[\0\n\r]/.test(value)) return null;
  if (!value.startsWith('~/') && !value.startsWith('/')) value = `~/${value}`;
  return value;
}

/** The config dirs a shell rc file points CLAUDE_CONFIG_DIR at, as "~/x" or "/abs", each one once. */
export function configDirsFromRc(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const pattern = /^\s*set\s/.test(line) ? FISH_SET : ASSIGNMENT;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
      const dir = normalize(m[1] ?? m[2] ?? m[3] ?? '');
      if (dir && !out.includes(dir)) out.push(dir);
    }
  }
  return out;
}
