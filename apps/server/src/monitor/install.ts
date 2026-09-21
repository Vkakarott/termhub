import {
  CLAUDE_DEFAULT_DIR,
  claudeDirsFromHome,
  configDirsFromRc,
  HOOK_ENV_REL,
  HOOK_MARK,
  HOOK_SCRIPT,
  HOOK_SCRIPT_REL,
  claudeConfigDirs,
  expandHome,
  hookEnvFile,
  mergeClaudeSettings,
  mergeCodexConfig,
  stripClaudeSettings,
  stripCodexConfig,
} from '@termhub/machine-ops';
import { agentRpc, requireAgentVersion } from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import { REMOTE_PATH_PREFIX, runOnMachine, runOnMachineWithInput, shellQuote } from '../terminal/machine-exec.js';

/**
 * Installs the monitor hooks on a machine: a small POSIX script under ~/.termhub/bin that
 * forwards the tools' hook payloads to termhub, and the entries that make Claude Code and
 * Codex call it. On ssh/local machines everything is written by one `sh -s` fed through
 * stdin; the Claude settings are read first and merged here (JSON), so nothing the user
 * configured is lost. Agent machines do the same through the `hooks.install` RPC (the agent
 * merges and writes the files itself, with the shared code in @termhub/machine-ops).
 */

/** First agent release that answers `hooks.install` / `hooks.uninstall`. */
export const HOOKS_MIN_AGENT_VERSION = '0.1.4';
/** First agent release that also hooks the accounts' own Claude config dirs (`claude_dirs`). */
export const HOOKS_CONFIG_DIRS_MIN_AGENT_VERSION = '0.1.5';

export interface HookInstallReport {
  home: string;
  claude: 'installed' | 'skipped';
  codex: 'installed' | 'skipped';
  /** the Claude config dirs that got the entries ("~/.claude", "~/.claude_work", …) */
  claude_dirs: string[];
  hooks_url: string;
}

/** POSIX `sh -s` on the machine: local and remote take the same script on stdin. */
function shOnMachine(machine: Machine, script: string, timeoutMs = 20_000) {
  return runOnMachineWithInput(machine, { file: 'sh', args: ['-s'] }, `${REMOTE_PATH_PREFIX}sh -s`, Buffer.from(script, 'utf8'), timeoutMs);
}

const SEP = '__TERMHUB_SEP__';

/** A dir as a shell word: "~/x" stays relative to the machine's $HOME, "/abs" is quoted as is. */
const shDir = (d: string) => (d.startsWith('~/') ? `"$HOME"/${shellQuote(d.slice(2))}` : shellQuote(d));

interface MachineConfigs {
  home: string;
  /** each Claude dir to hook, with whether it exists there and its current settings.json */
  claude: { dir: string; exists: boolean; settings: string }[];
  codexConfig: string;
  hasCodex: boolean;
}

/** $HOME, the settings.json of each Claude dir and the Codex config (empty when absent), in one round trip. */
async function readMachineConfigs(machine: Machine, claudeDirs: string[]): Promise<MachineConfigs> {
  const parts = [`printf '%s\\n' "$HOME"`];
  for (const d of claudeDirs) {
    parts.push(`printf '${SEP}\\n'; [ -d ${shDir(d)} ] && echo yes || echo no; printf '${SEP}\\n'; cat ${shDir(d)}/settings.json 2>/dev/null; printf '\\n'`);
  }
  parts.push(`printf '${SEP}\\n'; [ -d "$HOME/.codex" ] && echo yes || echo no; printf '${SEP}\\n'; cat "$HOME/.codex/config.toml" 2>/dev/null`);
  // a missing file is part of the answer, not a failure: the last `cat` must not set the exit code
  const script = `${parts.join('; ')}; true`;
  const r = await runOnMachine(machine, { file: 'sh', args: ['-c', script] }, script);
  if (r.code !== 0) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : 'Não foi possível ler a configuração da máquina');
  const chunks = r.stdout.split(`${SEP}\n`);
  const home = (chunks[0] ?? '').trim();
  if (!home.startsWith('/')) throw new Error('Não foi possível descobrir o $HOME da máquina');
  const claude = claudeDirs.map((dir, i) => ({
    dir,
    exists: (chunks[1 + i * 2] ?? '').trim() === 'yes',
    settings: (chunks[2 + i * 2] ?? '').replace(/\n$/, ''),
  }));
  const base = 1 + claudeDirs.length * 2;
  return { home, claude, hasCodex: (chunks[base] ?? '').trim() === 'yes', codexConfig: chunks[base + 1] ?? '' };
}

/** Quoted heredoc: the body is taken literally; the delimiter never appears in what we write. */
const heredoc = (path: string, body: string) => `cat > ${path} <<'__TERMHUB_EOF__'\n${body.endsWith('\n') ? body : `${body}\n`}__TERMHUB_EOF__\n`;

/** Writes `body` over `file` through a temp file + mv (readers never see half a file). */
const replaceFile = (file: string, body: string) => [heredoc(shellQuote(`${file}.termhub-new`), body), `mv ${shellQuote(`${file}.termhub-new`)} ${shellQuote(file)}`];

/** The account dirs that are not the default one; agents need 0.1.5 to take them. */
function extraDirs(accountDirs: string[]): string[] {
  return claudeConfigDirs(accountDirs).filter((d) => d !== CLAUDE_DEFAULT_DIR);
}

/** The `.claude*` dirs of the home (with the marker files inside each) and the rc files, in one round trip. */
const DISCOVERY_SCRIPT = [
  `for d in "$HOME"/.claude*; do [ -d "$d" ] || continue; printf '%s' "\${d##*/}"; for m in settings.json projects .credentials.json; do [ -e "$d/$m" ] && printf '\\t%s' "$m"; done; printf '\\n'; done`,
  `printf '${SEP}\\n'`,
  `for f in .zshrc .bashrc .bash_profile .profile .config/fish/config.fish; do cat "$HOME/$f" 2>/dev/null; printf '\\n'; done`,
  'true',
].join('; ');

/**
 * The Claude config dirs the machine itself knows about, so a person who runs Claude Code through
 * a CLAUDE_CONFIG_DIR alias is hooked without registering anything. A machine that cannot answer
 * is not an error: we simply hook what was registered (the agent path does the same on its own).
 */
async function discoverOnMachine(machine: Machine): Promise<string[]> {
  let stdout: string;
  try {
    const r = await runOnMachine(machine, { file: 'sh', args: ['-c', DISCOVERY_SCRIPT] }, DISCOVERY_SCRIPT);
    if (r.code !== 0) return [];
    stdout = r.stdout;
  } catch {
    return [];
  }
  const [listing = '', rc = ''] = stdout.split(`${SEP}\n`);
  const entries = listing
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name, ...files] = line.split('\t');
      return { name, files };
    });
  return [...claudeDirsFromHome(entries), ...configDirsFromRc(rc)];
}

/**
 * `accountDirs`: config dirs of the Claude accounts registered for this machine (CLAUDE_CONFIG_DIR);
 * they get the entries too, besides ~/.claude, when they exist on the machine.
 */
export async function installHooks(machine: Machine, token: string, hooksUrl: string, accountDirs: string[] = []): Promise<HookInstallReport> {
  if (!/^https?:\/\/[^\s'"]+$/.test(hooksUrl)) throw new Error('HOOKS_URL inválida');
  const extra = extraDirs(accountDirs);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, extra.length ? HOOKS_CONFIG_DIRS_MIN_AGENT_VERSION : HOOKS_MIN_AGENT_VERSION);
    const r = await agentRpc(machine, 'hooks.install', { hooks_url: hooksUrl, token, ...(extra.length ? { claude_dirs: extra } : {}) });
    return { home: r.home, claude: r.claude, codex: r.codex, claude_dirs: r.claude_dirs ?? [CLAUDE_DEFAULT_DIR], hooks_url: hooksUrl };
  }
  const { home, claude, codexConfig, hasCodex } = await readMachineConfigs(machine, claudeConfigDirs([...accountDirs, ...(await discoverOnMachine(machine))]));
  const scriptPath = `${home}/${HOOK_SCRIPT_REL}`;
  // ~/.claude is created when missing; an account's dir only when it is already there
  const targets = claude.filter((c) => c.dir === CLAUDE_DEFAULT_DIR || c.exists);
  const merged = targets.map((c) => {
    try {
      return { dir: c.dir, file: `${expandHome(c.dir, home)}/settings.json`, body: mergeClaudeSettings(c.settings, scriptPath) };
    } catch (err) {
      throw new Error(err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `${c.dir}/settings.json não é JSON válido` : err instanceof Error ? err.message : String(err));
    }
  });
  const mergedCodex = hasCodex ? mergeCodexConfig(codexConfig, scriptPath) : null;

  const q = shellQuote;
  const script = [
    'set -e',
    `mkdir -p "$HOME/.termhub/bin" "$HOME/.claude"`,
    `umask 077`,
    heredoc(q(`${home}/${HOOK_ENV_REL}`), hookEnvFile(hooksUrl, token)),
    `umask 022`,
    heredoc(q(scriptPath), HOOK_SCRIPT),
    `chmod 755 ${q(scriptPath)}`,
    ...merged.flatMap((m) => replaceFile(m.file, m.body)),
    ...(mergedCodex !== null ? replaceFile(`${home}/.codex/config.toml`, mergedCodex) : []),
    'echo ok',
  ].join('\n');
  const r = await shOnMachine(machine, script);
  if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : `Instalação falhou: ${r.stderr.trim().split('\n').pop() || 'erro desconhecido'}`);
  return { home, claude: 'installed', codex: mergedCodex !== null ? 'installed' : 'skipped', claude_dirs: merged.map((m) => m.dir), hooks_url: hooksUrl };
}

export async function uninstallHooks(machine: Machine, accountDirs: string[] = []): Promise<void> {
  const extra = extraDirs(accountDirs);
  if (machine.type === 'agent') {
    requireAgentVersion(machine, extra.length ? HOOKS_CONFIG_DIRS_MIN_AGENT_VERSION : HOOKS_MIN_AGENT_VERSION);
    await agentRpc(machine, 'hooks.uninstall', extra.length ? { claude_dirs: extra } : {});
    return;
  }
  const { home, claude, codexConfig, hasCodex } = await readMachineConfigs(machine, claudeConfigDirs([...accountDirs, ...(await discoverOnMachine(machine))]));
  const stripped: { file: string; body: string }[] = [];
  for (const c of claude) {
    if (!c.settings.trim()) continue;
    try {
      stripped.push({ file: `${expandHome(c.dir, home)}/settings.json`, body: stripClaudeSettings(c.settings) });
    } catch {
      // unreadable JSON: leave the file alone
    }
  }
  const q = shellQuote;
  const script = [
    'set -e',
    `rm -f ${q(`${home}/${HOOK_SCRIPT_REL}`)} ${q(`${home}/${HOOK_ENV_REL}`)}`,
    ...stripped.flatMap((s) => replaceFile(s.file, s.body)),
    ...(hasCodex && codexConfig.includes(HOOK_MARK) ? replaceFile(`${home}/.codex/config.toml`, stripCodexConfig(codexConfig)) : []),
    'echo ok',
  ].join('\n');
  const r = await shOnMachine(machine, script);
  if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : `Remoção falhou: ${r.stderr.trim().split('\n').pop() || 'erro desconhecido'}`);
}
