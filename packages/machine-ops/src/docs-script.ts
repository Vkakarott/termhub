/** A `docs.read` call never touches a file larger than this (spec D15). Scan still reports its size. */
export const DOCS_MAX_BYTES = 256 * 1024;
/** `docs.scan` never lists more than this many files per link (spec D15): the first this-many by name. */
export const DOCS_MAX_FILES = 200;

/** One `docs/superpowers/{specs,plans}/*.md` file as `docs.scan` reports it. `path` is relative to `cwd`. */
export interface DocEntry {
  path: string;
  sha256: string;
  size: number;
}

/**
 * POSIX sh, portable to Linux (`sha256sum`) and macOS (`shasum -a 256`); always exits 0. Walks only
 * `docs/superpowers/specs` and `docs/superpowers/plans` (not recursively, and never `docs/other/…` or a
 * `specs`/`plans` outside that tree), skipping symlinks (`[ -L ]`) and any name the character-class check
 * would refuse (the same class `docPath` — see `@termhub/agent-protocol`'s `rpc.ts` — regexes against: only
 * `A-Za-z0-9._-`, plus `/` for the directory separators produced by the walk itself). One line per file,
 * `F\t<sha256>\t<size>\t<relpath>`; a missing `docs/superpowers` (or either subdir) yields zero lines, not
 * an error — only a missing `cwd` does (`ERR:notfound`). `parseDocsScan` reads the output back.
 */
export function buildDocsScanScript(cwdQuoted: string): string {
  return [
    `CWD=${cwdQuoted}`,
    `cd -- "$CWD" 2>/dev/null || { echo 'ERR:notfound'; exit 0; }`,
    `if command -v sha256sum >/dev/null 2>&1; then H='sha256sum'; else H='shasum -a 256'; fi`,
    `n=0`,
    `for d in docs/superpowers/specs docs/superpowers/plans; do`,
    `  [ -d "$d" ] || continue`,
    `  for f in "$d"/*.md; do`,
    `    [ -f "$f" ] && [ ! -L "$f" ] || continue`,
    `    case "$f" in *[!A-Za-z0-9._/-]*) continue;; esac`,
    `    n=$((n+1)); [ "$n" -le ${DOCS_MAX_FILES} ] || break 2`,
    `    s=$(wc -c < "$f" | tr -d ' ')`,
    `    h=$($H "$f" | cut -d' ' -f1)`,
    `    printf 'F\\t%s\\t%s\\t%s\\n' "$h" "$s" "$f"`,
    `  done`,
    `done`,
  ].join('\n');
}

/**
 * POSIX sh, always exits 0. `quotedPaths` are already `shellQuote`d by the caller (the agent handler),
 * one shell word each, so this can just list them in a `for`. Defence in depth even though the server
 * only ever sends paths `docPath` already validated: each path is re-checked against the same directory
 * prefix and character class `buildDocsScanScript` uses, then `-f`/`-L`/size before being read, so a path
 * that somehow bypassed the zod schema still cannot make this script leave the docs tree or read a huge
 * file. Per file: `B\t<relpath>\n` + base64 body + `E\n`; a file over `DOCS_MAX_BYTES`, or one that fails
 * any check, is skipped silently (the manifest from `docs.scan` already told the caller its size).
 */
export function buildDocsReadScript(cwdQuoted: string, quotedPaths: string[]): string {
  return [
    `CWD=${cwdQuoted}`,
    `cd -- "$CWD" 2>/dev/null || { echo 'ERR:notfound'; exit 0; }`,
    `for f in ${quotedPaths.join(' ')}; do`,
    `  case "$f" in`,
    `    docs/superpowers/specs/*.md) ;;`,
    `    docs/superpowers/plans/*.md) ;;`,
    `    *) continue ;;`,
    `  esac`,
    `  case "$f" in *[!A-Za-z0-9._/-]*) continue;; esac`,
    `  [ -f "$f" ] && [ ! -L "$f" ] || continue`,
    `  s=$(wc -c < "$f" | tr -d ' ')`,
    `  [ "$s" -le ${DOCS_MAX_BYTES} ] || continue`,
    `  printf 'B\\t%s\\n' "$f"`,
    `  base64 < "$f"`,
    `  echo E`,
    `done`,
  ].join('\n');
}

/** Reads `buildDocsScanScript`'s stdout back. `err` is the `ERR:` tag's payload (e.g. `notfound`), or null. */
export function parseDocsScan(stdout: string): { entries: DocEntry[]; err: string | null } {
  const entries: DocEntry[] = [];
  let err: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('ERR:')) {
      err = line.slice('ERR:'.length);
      continue;
    }
    if (!line.startsWith('F\t')) continue;
    const [, sha256, sizeText, path] = line.split('\t');
    const size = Number(sizeText);
    if (sha256 === undefined || path === undefined || !Number.isFinite(size)) continue;
    entries.push({ path, sha256, size });
  }
  return { entries, err };
}

/** Reads `buildDocsReadScript`'s stdout back: relpath -> UTF-8 text. A skipped file is simply absent. */
export function parseDocsRead(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = stdout.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || !line.startsWith('B\t')) {
      i++;
      continue;
    }
    const path = line.slice('B\t'.length);
    i++;
    const b64Lines: string[] = [];
    while (i < lines.length && lines[i] !== 'E') {
      b64Lines.push(lines[i] ?? '');
      i++;
    }
    i++; // skip the 'E' line (or the end of stdout, if truncated)
    result.set(path, Buffer.from(b64Lines.join(''), 'base64').toString('utf8'));
  }
  return result;
}
