import { HOOK_ENV_REL, HOOK_MARK, HOOK_SCRIPT, HOOK_SCRIPT_REL, hookEnvFile, mergeClaudeSettings, mergeCodexConfig, stripClaudeSettings, stripCodexConfig } from '@termhub/machine-ops';
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

/** Quoted heredoc: the body is taken literally; the delimiter never appears in what we write. */
const heredoc = (path: string, body: string) => `cat > ${path} <<'__TERMHUB_EOF__'\n${body.endsWith('\n') ? body : `${body}\n`}__TERMHUB_EOF__\n`;

export async function installHooks(machine: Machine, token: string, hooksUrl: string): Promise<HookInstallReport> {
  if (!/^https?:\/\/[^\s'"]+$/.test(hooksUrl)) throw new Error('HOOKS_URL inválida');
  if (machine.type === 'agent') {
    requireAgentVersion(machine, HOOKS_MIN_AGENT_VERSION);
    const r = await agentRpc(machine, 'hooks.install', { hooks_url: hooksUrl, token });
    return { ...r, hooks_url: hooksUrl };
  }
  const { home, claudeSettings, codexConfig, hasCodex } = await readMachineConfigs(machine);
  const scriptPath = `${home}/${HOOK_SCRIPT_REL}`;
  const mergedClaude = mergeClaudeSettings(claudeSettings, scriptPath);
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
  if (machine.type === 'agent') {
    requireAgentVersion(machine, HOOKS_MIN_AGENT_VERSION);
    await agentRpc(machine, 'hooks.uninstall', {});
    return;
  }
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
    ...(hasCodex && codexConfig.includes(HOOK_MARK)
      ? [heredoc(q(`${home}/.codex/config.toml.termhub-new`), stripCodexConfig(codexConfig)), `mv ${q(`${home}/.codex/config.toml.termhub-new`)} ${q(`${home}/.codex/config.toml`)}`]
      : []),
    'echo ok',
  ].join('\n');
  const r = await shOnMachine(machine, script);
  if (r.code !== 0 || !r.stdout.includes('ok')) throw new Error(r.timedOut ? 'A máquina não respondeu a tempo' : `Remoção falhou: ${r.stderr.trim().split('\n').pop() || 'erro desconhecido'}`);
}
