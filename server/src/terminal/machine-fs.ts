import type { Machine } from '../db/repositories/types.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { runOnMachine, shellQuote } from './machine-exec.js';

export interface FsRoot {
  kind: 'home' | 'disk';
  label: string;
  path: string;
  /** dispositivo / origem do mount (só disk) */
  source?: string;
  size_kb?: number;
  avail_kb?: number;
}

export interface FsEntry {
  name: string;
  path: string;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  roots: FsRoot[];
}

/** Sistemas de arquivos virtuais que não interessam como "disco". */
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'udev', 'overlay', 'squashfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'efivarfs', 'devpts',
  'mqueue', 'hugetlbfs', 'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl', 'none', 'shm',
  'devfs', 'autofs', 'ramfs', 'binfmt_misc', 'nsfs', 'rpc_pipefs', 'map', 'sunrpc', 'systemd-1', 'gvfsd-fuse',
]);
/** Mount points que nunca servem para projeto. */
const EXCLUDED_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap', '/boot', '/var/lib/docker', '/var/snap', '/System/Volumes', '/private/var/vm', '/Volumes/Recovery'];

function isProjectDisk(source: string, mount: string): boolean {
  if (!mount.startsWith('/')) return false;
  if (PSEUDO_FS.has(source) || source.startsWith('fuse.') || source.startsWith('map ')) return false;
  if (EXCLUDED_MOUNT_PREFIXES.some((p) => mount === p || mount.startsWith(p + '/'))) return false;
  return true;
}

function diskLabel(mount: string): string {
  if (mount === '/') return 'Raiz (/)';
  const last = mount.split('/').filter(Boolean).pop();
  return last ?? mount;
}

/**
 * Script sh portátil (Linux/macOS). Sai sempre com 0; erros de diretório viram linhas ERR:.
 * O caminho já vem escapado com shellQuote; "~" e "~/x" são expandidos na máquina de destino.
 */
function buildScript(quotedPath: string): string {
  return [
    `P=${quotedPath}`,
    `case "$P" in ""|"~") P=$HOME;; "~/"*) P="$HOME/\${P#\\~/}";; esac`,
    `echo "HOME:$HOME"`,
    // discos: fonte, tamanho, livre e mount point (mount pode ter espaços: fica no fim da linha)
    `df -Pk 2>/dev/null | tail -n +2 | while IFS= read -r line; do set -- $line; src=$1; size=$2; avail=$4; shift 5; [ -d "$*" ] && printf 'MNT:%s\\t%s\\t%s\\t%s\\n' "$src" "$size" "$avail" "$*"; done`,
    `if [ ! -e "$P" ]; then echo "ERR:notfound"; exit 0; fi`,
    `if [ ! -d "$P" ]; then echo "ERR:notdir"; exit 0; fi`,
    `cd -- "$P" 2>/dev/null || { echo "ERR:denied"; exit 0; }`,
    `echo "PWD:$(pwd)"`,
    `ls -1Ap 2>/dev/null | grep '/$' | sed 's#/$##' | while IFS= read -r n; do echo "DIR:$n"; done`,
    `exit 0`,
  ].join('; ');
}

function parseOutput(stdout: string): { home: string | null; pwd: string | null; err: string | null; dirs: string[]; mounts: FsRoot[] } {
  let home: string | null = null;
  let pwd: string | null = null;
  let err: string | null = null;
  const dirs: string[] = [];
  const mounts: FsRoot[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('HOME:')) home = line.slice(5) || null;
    else if (line.startsWith('PWD:')) pwd = line.slice(4).replace(/^\/{2,}/, '/') || null;
    else if (line.startsWith('ERR:')) err = line.slice(4);
    else if (line.startsWith('DIR:')) dirs.push(line.slice(4));
    else if (line.startsWith('MNT:')) {
      const [source, size, avail, mount] = line.slice(4).split('\t');
      if (!source || !mount || !isProjectDisk(source, mount)) continue;
      const sizeKb = Number(size);
      const availKb = Number(avail);
      mounts.push({
        kind: 'disk',
        label: diskLabel(mount),
        path: mount,
        source,
        size_kb: Number.isFinite(sizeKb) ? sizeKb : undefined,
        avail_kb: Number.isFinite(availKb) ? availKb : undefined,
      });
    }
  }
  return { home, pwd, err, dirs, mounts };
}

function parentOf(path: string): string | null {
  if (path === '/') return null;
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/** Lista subdiretórios de `path` (padrão: $HOME) e os discos/mounts da máquina. */
export async function browseMachine(machine: Machine, path: string | undefined): Promise<FsListing> {
  const raw = (path ?? '').trim();
  if (raw.includes('\0') || raw.includes('\n')) throw badRequest('Caminho inválido');
  if (raw && raw !== '~' && !raw.startsWith('~/') && !raw.startsWith('/')) throw badRequest('Informe um caminho absoluto');

  const script = buildScript(shellQuote(raw));
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 10000);
  if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder');
  if (r.code !== 0) throw new HttpError(502, machine.type === 'ssh' ? 'Máquina inacessível via SSH' : 'Falha ao listar diretórios');

  const out = parseOutput(r.stdout);
  if (out.err === 'notfound') throw notFound('Diretório não existe na máquina');
  if (out.err === 'notdir') throw badRequest('O caminho não é um diretório');
  if (out.err === 'denied') throw forbidden('Sem permissão para acessar o diretório');
  if (!out.pwd) throw new HttpError(502, 'Resposta inesperada da máquina');

  const roots: FsRoot[] = [];
  if (out.home) roots.push({ kind: 'home', label: 'Home', path: out.home });
  // dedup por mount point (macOS repete o mesmo volume) e ordena: "/" primeiro, depois alfabético
  const seen = new Set<string>();
  for (const m of out.mounts.sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)))) {
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    roots.push(m);
  }

  const base = out.pwd === '/' ? '' : out.pwd;
  return {
    path: out.pwd,
    parent: parentOf(out.pwd),
    entries: out.dirs.map((name) => ({ name, path: `${base}/${name}` })),
    roots,
  };
}

const DIR_NAME_RE = /^[^/\\\0\n\r]{1,255}$/;
/** Nome de pasta simples: sem separadores, sem "." ou "..", sem controle. */
export function assertDirName(name: string): void {
  if (!DIR_NAME_RE.test(name) || name === '.' || name === '..' || /[\x00-\x1f]/.test(name)) throw badRequest('Nome de pasta inválido');
}

/** Expansão de "~" feita na máquina de destino (o shell só expande fora de aspas). */
const EXPAND_HOME = `case "$P" in "~") P=$HOME;; "~/"*) P="$HOME/\${P#\\~/}";; esac`;

async function runFsScript(machine: Machine, script: string): Promise<string> {
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 10000);
  if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder');
  if (r.code !== 0) throw new HttpError(502, machine.type === 'ssh' ? 'Máquina inacessível via SSH' : 'Falha ao acessar o sistema de arquivos');
  return r.stdout;
}

function firstTag(stdout: string, tag: string): string | null {
  const line = stdout.split('\n').find((l) => l.startsWith(tag + ':'));
  return line ? line.slice(tag.length + 1).replace(/^\/{2,}/, '/') : null;
}

/** Cria `name` dentro de `parent` na máquina e devolve o caminho absoluto da nova pasta. */
export async function makeDirectory(machine: Machine, parent: string, name: string): Promise<string> {
  assertDirName(name);
  const raw = parent.trim();
  if (!raw.startsWith('/') && raw !== '~' && !raw.startsWith('~/')) throw badRequest('Informe um caminho absoluto');
  const script = [
    `P=${shellQuote(raw)}`,
    EXPAND_HOME,
    `cd -- "$P" 2>/dev/null || { echo "ERR:parent"; exit 0; }`,
    `N=${shellQuote(name)}`,
    `if [ -e "$N" ]; then echo "ERR:exists"; exit 0; fi`,
    `mkdir -- "$N" 2>/dev/null || { echo "ERR:denied"; exit 0; }`,
    `cd -- "$N" && echo "PWD:$(pwd)"`,
    `exit 0`,
  ].join('; ');
  const out = await runFsScript(machine, script);
  const err = firstTag(out, 'ERR');
  if (err === 'parent') throw notFound('A pasta de destino não existe na máquina');
  if (err === 'exists') throw conflict('Já existe um arquivo ou pasta com esse nome');
  if (err === 'denied') throw forbidden('Sem permissão para criar a pasta');
  const pwd = firstTag(out, 'PWD');
  if (!pwd) throw new HttpError(502, 'Resposta inesperada da máquina');
  return pwd;
}

/**
 * Confere que `path` é um diretório na máquina (expande "~"), criando com mkdir -p se `create`.
 * Devolve o caminho absoluto resolvido, que é o que deve ser gravado no projeto.
 */
export async function ensureDirectory(machine: Machine, path: string, create: boolean): Promise<{ path: string; created: boolean }> {
  const raw = path.trim();
  if (!raw.startsWith('/') && raw !== '~' && !raw.startsWith('~/')) throw badRequest('Informe um caminho absoluto');
  const script = [
    `P=${shellQuote(raw)}`,
    EXPAND_HOME,
    `if [ -d "$P" ]; then cd -- "$P" 2>/dev/null && echo "PWD:$(pwd)" || echo "ERR:denied"; exit 0; fi`,
    `if [ -e "$P" ]; then echo "ERR:notdir"; exit 0; fi`,
    create ? `mkdir -p -- "$P" 2>/dev/null && cd -- "$P" && echo "CREATED:$(pwd)" || echo "ERR:mkdir"` : `echo "ERR:notfound"`,
    `exit 0`,
  ].join('; ');
  const out = await runFsScript(machine, script);
  const err = firstTag(out, 'ERR');
  if (err === 'notfound') throw new HttpError(400, 'A pasta não existe na máquina. Marque "criar a pasta" ou escolha outra.', 'DIR_NOT_FOUND');
  if (err === 'notdir') throw badRequest('O caminho existe, mas não é uma pasta');
  if (err === 'denied') throw forbidden('Sem permissão para acessar a pasta');
  if (err === 'mkdir') throw forbidden('Não foi possível criar a pasta (permissão?)');
  const created = firstTag(out, 'CREATED');
  const pwd = created ?? firstTag(out, 'PWD');
  if (!pwd) throw new HttpError(502, 'Resposta inesperada da máquina');
  return { path: pwd, created: created != null };
}
