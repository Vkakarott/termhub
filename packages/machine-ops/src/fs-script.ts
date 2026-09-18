/** Expansão de "~" feita na máquina de destino (o shell só expande fora de aspas). */
export const EXPAND_HOME = `case "$P" in "~") P=$HOME;; "~/"*) P="$HOME/\${P#\\~/}";; esac`;

/**
 * Script sh portátil (Linux/macOS). Sai sempre com 0; erros de diretório viram linhas ERR:.
 * O caminho já vem escapado com shellQuote; "~" e "~/x" são expandidos na máquina de destino.
 */
export function buildFsListScript(quotedPath: string): string {
  return [
    `P=${quotedPath}`,
    `case "$P" in ""|"~") P=$HOME;; "~/"*) P="$HOME/\${P#\\~/}";; esac`,
    `echo "HOME:$HOME"`,
    // discos: fonte, tamanho, livre e mount point (mount pode ter espaços: fica no fim da linha)
    `df -Pk 2>/dev/null | tail -n +2 | while IFS= read -r line; do set -- $line; src=$1; size=$2; avail=$4; shift 5; [ -d "$*" ] && printf 'MNT:%s\\t%s\\t%s\\t%s\\n' "$src" "$size" "$avail" "$*"; done`,
    `if [ ! -e "$P" ]; then echo "ERR:notfound"; exit 0; fi`,
    `if [ ! -r "$P" ] || [ ! -x "$P" ]; then echo "ERR:eperm"; exit 0; fi`,
    `if [ ! -d "$P" ]; then echo "ERR:notdir"; exit 0; fi`,
    `cd -- "$P" 2>/dev/null || { echo "ERR:denied"; exit 0; }`,
    `echo "PWD:$(pwd)"`,
    `ls -1Ap 2>/dev/null | grep '/$' | sed 's#/$##' | while IFS= read -r n; do echo "DIR:$n"; done`,
    `exit 0`,
  ].join('; ');
}

export interface MkdirOptions {
  /** `mkdir -p` on `parent/name`: missing parents are created too and `ERR:parent` never fires. */
  recursive?: boolean;
}

/**
 * Creates `quotedName` inside `quotedParent` on the machine; both already shell-quoted.
 * Default (leaf only): the parent must exist (`ERR:parent`). `recursive` mirrors the
 * `mkdir -p` the ssh/local `ensureDirectory` runs, so a nested new project path works the
 * same on an agent machine. The non-recursive script is unchanged (shared by `makeDirectory`).
 */
export function buildMkdirScript(quotedParent: string, quotedName: string, opts: MkdirOptions = {}): string {
  if (opts.recursive) {
    return [
      `P=${quotedParent}`,
      EXPAND_HOME,
      `N=${quotedName}`,
      `if [ -e "$P/$N" ]; then echo "ERR:exists"; exit 0; fi`,
      `mkdir -p -- "$P/$N" 2>/dev/null || { echo "ERR:denied"; exit 0; }`,
      `cd -- "$P/$N" && echo "PWD:$(pwd)"`,
      `exit 0`,
    ].join('; ');
  }
  return [
    `P=${quotedParent}`,
    EXPAND_HOME,
    `cd -- "$P" 2>/dev/null || { echo "ERR:parent"; exit 0; }`,
    `N=${quotedName}`,
    `if [ -e "$N" ]; then echo "ERR:exists"; exit 0; fi`,
    `mkdir -- "$N" 2>/dev/null || { echo "ERR:denied"; exit 0; }`,
    `cd -- "$N" && echo "PWD:$(pwd)"`,
    `exit 0`,
  ].join('; ');
}
