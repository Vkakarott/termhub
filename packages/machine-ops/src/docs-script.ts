import { EXPAND_HOME } from './fs-script.js';

/** A `docs.read` call never touches a file larger than this (spec D15). Scan still reports its size. */
export const DOCS_MAX_BYTES = 256 * 1024;
/** `docs.scan` never lists more than this many files per link (spec D15): the first this-many by name. */
export const DOCS_MAX_FILES = 200;
/**
 * Cumulative raw-byte budget for one `docs.read` call. `docs.read`'s result travels as a single
 * control frame (`sendControl` in the agent, never chunked like stream data), and the server's
 * WebSocket accepts at most `MAX_FRAME` (1 MiB, `@termhub/agent-protocol`'s `frames.ts`) per frame
 * — a bigger frame drops the whole agent connection, every terminal on that machine included. Base64
 * inflates raw bytes by 4/3, and JSON-encoding the result escapes each embedded newline to two
 * characters, so 600 KiB raw lands at roughly 840 KiB serialised: comfortably under 1 MiB with the
 * rest of the envelope. The script stops *before* the file that would cross this budget and leaves
 * it (and everything requested after it) unread; the caller just asks for the tail on its next call.
 * A single file is always ≤ `DOCS_MAX_BYTES` (256 KiB), so the first file in any call always fits.
 */
export const DOCS_READ_MAX_BYTES = 600 * 1024;

/** Same regex as `docPath`/`DOC_PATH_RE` in `@termhub/agent-protocol` (whose `docPath` uses this
 *  shape too) — duplicated here because `@termhub/machine-ops` has no dependency on that package
 *  (kept dependency-free, same reason `simulator.ts`'s `UDID_RE` is its own copy). Keep both in sync.
 *  `docs/lessons/*.md` (spec 2026-09-27 failure lessons) is included, `docs/lessons/README.md`
 *  never — that file documents the format itself, not a lesson. */
export const DOC_PATH_RE = /^docs\/(?:superpowers\/(?:specs|plans)\/[A-Za-z0-9._-]{1,200}\.md|lessons\/(?!README\.md$)[A-Za-z0-9._-]{1,200}\.md)$/;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/** A size field must be one or more decimal digits — nothing else. `Number('')`, `Number(' ')` and
 *  `Number('0x10')` all parse as finite integers in JS (0, 0 and 16), so a plain `Number.isInteger`
 *  check would accept an empty/blank size (e.g. from `wc -c` failing on an unreadable file) or a hex
 *  literal; this regex is checked before `Number(...)` is ever called on the field. */
const SIZE_RE = /^\d+$/;

/** One `docs/superpowers/{specs,plans}/*.md` file as `docs.scan` reports it. `path` is relative to
 *  `cwd`. `sha256` is `null` for a file over `DOCS_MAX_BYTES` — the scan script skips hashing it
 *  (it will never be read anyway), but still reports its size so the caller knows it exists. */
export interface DocEntry {
  path: string;
  sha256: string | null;
  size: number;
}

/**
 * Shell snippet (assumes `cd` already happened): sets `specs_ok`/`plans_ok`/`lessons_ok` to `0` when
 * the matching ancestor directory is itself a symlink. `[ -L "$f" ]` on the leaf file alone is not
 * enough — a symlinked `docs`, `docs/superpowers`, `specs`, `plans` or `docs/lessons` directory would
 * make every file under it resolve outside the intended tree while still passing a plain `-f`/`-d`
 * check (those follow symlinks). Checking a path that does not exist is safe: `-L` on a missing path
 * is simply false, so a link only ever *narrows* which branch is walked, never widens it.
 */
const SYMLINKED_DIR_GUARD = [
  `specs_ok=1; plans_ok=1; lessons_ok=1`,
  `[ ! -L docs ] || { specs_ok=0; plans_ok=0; lessons_ok=0; }`,
  `[ ! -L docs/superpowers ] || { specs_ok=0; plans_ok=0; }`,
  `[ ! -L docs/superpowers/specs ] || specs_ok=0`,
  `[ ! -L docs/superpowers/plans ] || plans_ok=0`,
  `[ ! -L docs/lessons ] || lessons_ok=0`,
].join('\n');

/**
 * POSIX sh, portable to Linux (`sha256sum`) and macOS (`shasum -a 256`); always exits 0. Walks only
 * `docs/superpowers/specs`, `docs/superpowers/plans` and `docs/lessons` (not recursively, and never
 * `docs/other/…` or a `specs`/`plans`/`lessons` outside that tree — see `SYMLINKED_DIR_GUARD`),
 * skipping symlinked files (`[ -L ]`), `docs/lessons/README.md` (the format's own doc, spec
 * 2026-09-27 failure lessons D14/D4) and any name the character-class check would refuse (only
 * `A-Za-z0-9._-`, plus `/` for the directory separators the walk itself produces). One line per file:
 * `F\t<sha256>\t<size>\t<relpath>` normally, or `S\t<size>\t<relpath>` (no hash) for a file over
 * `DOCS_MAX_BYTES` — it will never be read, so hashing it would just cost time/IO for nothing. A
 * missing `docs/superpowers` (or either subdir) or `docs/lessons` yields zero lines, not an error —
 * only a missing `cwd` (`ERR:notfound`) or neither hasher being on `PATH` (`ERR:nohash`) does.
 * `"~"`/`"~/…"` in `cwd` are expanded on the machine, the same way `buildFsListScript` does.
 * `parseDocsScan` reads the output back.
 */
export function buildDocsScanScript(cwdQuoted: string): string {
  return [
    `P=${cwdQuoted}`,
    EXPAND_HOME,
    `cd -- "$P" 2>/dev/null || { echo 'ERR:notfound'; exit 0; }`,
    `if command -v sha256sum >/dev/null 2>&1; then H='sha256sum'`,
    `elif command -v shasum >/dev/null 2>&1; then H='shasum -a 256'`,
    `else echo 'ERR:nohash'; exit 0`,
    `fi`,
    SYMLINKED_DIR_GUARD,
    `n=0`,
    `for d in docs/superpowers/specs docs/superpowers/plans docs/lessons; do`,
    `  [ -d "$d" ] || continue`,
    `  case "$d" in`,
    `    docs/superpowers/specs) [ "$specs_ok" = 1 ] || continue ;;`,
    `    docs/superpowers/plans) [ "$plans_ok" = 1 ] || continue ;;`,
    `    docs/lessons) [ "$lessons_ok" = 1 ] || continue ;;`,
    `  esac`,
    `  for f in "$d"/*.md; do`,
    `    [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || continue`,
    `    case "$f" in *[!A-Za-z0-9._/-]*) continue;; esac`,
    `    case "$f" in docs/lessons/README.md) continue;; esac`,
    `    n=$((n+1)); [ "$n" -le ${DOCS_MAX_FILES} ] || break 2`,
    `    s=$(wc -c < "$f" | tr -d ' ')`,
    `    [ -n "$s" ] || continue`,
    `    if [ "$s" -le ${DOCS_MAX_BYTES} ]; then`,
    `      h=$($H "$f" | cut -d' ' -f1)`,
    `      printf 'F\\t%s\\t%s\\t%s\\n' "$h" "$s" "$f"`,
    `    else`,
    `      printf 'S\\t%s\\t%s\\n' "$s" "$f"`,
    `    fi`,
    `  done`,
    `done`,
  ].join('\n');
}

/**
 * POSIX sh, always exits 0. `quotedPaths` are already `shellQuote`d by the caller (the agent
 * handler), one shell word each, so this can just list them in a `for`. Defence in depth even
 * though the server only ever sends paths `docPath` already validated: each path is re-checked
 * against the same directory prefix, rejects any path with an extra `/` past the file name (blocks
 * `docs/superpowers/specs/../../../x.md` — the character-class check alone would not, since `.` and
 * `/` are both allowed characters; the extra-`/` check is what actually stops traversal), the same
 * character class, the same symlinked-ancestor guard as `buildDocsScanScript`, then `-f`/`-L`/size —
 * and, for `docs/lessons`, never `README.md` (spec 2026-09-27 failure lessons). Per file:
 * `B\t<size>\t<relpath>\n` + base64 body + `E\n`. A file over `DOCS_MAX_BYTES`, one that
 * fails any check, or a symlinked ancestor is skipped silently (the manifest from `docs.scan`
 * already told the caller its size or that it isn't there). The loop also stops — leaving every
 * requested path from there on unread — the moment cumulative raw bytes would cross
 * `DOCS_READ_MAX_BYTES`, so the whole result fits in one WebSocket frame (see that constant's doc
 * comment); the caller just asks again for what did not come back. `"~"`/`"~/…"` in `cwd` are
 * expanded on the machine. `parseDocsRead` reads the output back.
 */
export function buildDocsReadScript(cwdQuoted: string, quotedPaths: string[]): string {
  return [
    `P=${cwdQuoted}`,
    EXPAND_HOME,
    `cd -- "$P" 2>/dev/null || { echo 'ERR:notfound'; exit 0; }`,
    SYMLINKED_DIR_GUARD,
    `total=0`,
    `for f in ${quotedPaths.join(' ')}; do`,
    `  case "$f" in`,
    `    docs/superpowers/specs/*.md) [ "$specs_ok" = 1 ] || continue ;;`,
    `    docs/superpowers/plans/*.md) [ "$plans_ok" = 1 ] || continue ;;`,
    `    docs/lessons/*.md) [ "$lessons_ok" = 1 ] || continue ;;`,
    `    *) continue ;;`,
    `  esac`,
    `  case "$f" in docs/superpowers/specs/*/*|docs/superpowers/plans/*/*|docs/lessons/*/*) continue;; esac`,
    `  case "$f" in docs/lessons/README.md) continue;; esac`,
    `  case "$f" in *[!A-Za-z0-9._/-]*) continue;; esac`,
    `  [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || continue`,
    `  s=$(wc -c < "$f" | tr -d ' ')`,
    `  [ -n "$s" ] || continue`,
    `  [ "$s" -le ${DOCS_MAX_BYTES} ] || continue`,
    `  newtotal=$((total + s))`,
    `  [ "$newtotal" -le ${DOCS_READ_MAX_BYTES} ] || break`,
    `  total=$newtotal`,
    `  printf 'B\\t%s\\t%s\\n' "$s" "$f"`,
    `  base64 < "$f"`,
    `  echo E`,
    `done`,
  ].join('\n');
}

/**
 * Reads `buildDocsScanScript`'s stdout back. `err` is the `ERR:` tag's payload (e.g. `notfound`,
 * `nohash`), or null. A malformed line (bad sha256, non-integer size, or a path that does not match
 * `DOC_PATH_RE` — a corrupted or truncated frame, or a hasher that printed something unexpected) is
 * dropped rather than surfaced as a bogus entry.
 */
export function parseDocsScan(stdout: string): { entries: DocEntry[]; err: string | null } {
  const entries: DocEntry[] = [];
  let err: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('ERR:')) {
      err = line.slice('ERR:'.length);
      continue;
    }
    if (line.startsWith('F\t')) {
      const [, sha256, sizeText, path] = line.split('\t');
      if (sha256 === undefined || sizeText === undefined || path === undefined) continue;
      if (!SHA256_HEX_RE.test(sha256) || !SIZE_RE.test(sizeText) || !DOC_PATH_RE.test(path)) continue;
      entries.push({ path, sha256, size: Number(sizeText) });
      continue;
    }
    if (line.startsWith('S\t')) {
      const [, sizeText, path] = line.split('\t');
      if (sizeText === undefined || path === undefined) continue;
      if (!SIZE_RE.test(sizeText) || !DOC_PATH_RE.test(path)) continue;
      entries.push({ path, sha256: null, size: Number(sizeText) });
    }
  }
  return { entries, err };
}

/**
 * Reads `buildDocsReadScript`'s stdout back: relpath -> UTF-8 text. A file whose body was cut off
 * (no terminating `E` reached before stdout ran out — a truncated frame or a killed process),
 * whose size field is not a plain decimal integer, whose path does not match `DOC_PATH_RE`, or
 * whose decoded byte length does not match the size the `B` line declared (a failed/partial
 * `base64`) is dropped rather than stored as empty or partial text; a skipped file is simply absent.
 */
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
    const [, sizeText, path] = line.split('\t');
    i++;
    const b64Lines: string[] = [];
    let terminated = false;
    while (i < lines.length) {
      if (lines[i] === 'E') {
        terminated = true;
        i++;
        break;
      }
      b64Lines.push(lines[i] ?? '');
      i++;
    }
    if (!terminated || sizeText === undefined || path === undefined) continue;
    if (!SIZE_RE.test(sizeText) || !DOC_PATH_RE.test(path)) continue;
    const size = Number(sizeText);
    const buf = Buffer.from(b64Lines.join(''), 'base64');
    if (buf.length !== size) continue;
    result.set(path, buf.toString('utf8'));
  }
  return result;
}
