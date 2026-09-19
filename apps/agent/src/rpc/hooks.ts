import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { HOOK_ENV_REL, HOOK_MARK, HOOK_SCRIPT, HOOK_SCRIPT_REL, hookEnvFile, mergeClaudeSettings, mergeCodexConfig, stripClaudeSettings, stripCodexConfig } from '@termhub/machine-ops';
import { RpcFailure } from '../exec.js';

/**
 * Monitor hooks on this machine, written with node:fs (no shell): the forwarding script under
 * ~/.termhub/bin, its env file (url + token, 0600) and our entries in ~/.claude/settings.json
 * and, when Codex is installed, ~/.codex/config.toml. The merge/strip logic is the same the
 * server uses for ssh machines (@termhub/machine-ops), so both paths leave the files identical.
 */

const CLAUDE_SETTINGS_REL = '.claude/settings.json';
const CODEX_DIR_REL = '.codex';
const CODEX_CONFIG_REL = '.codex/config.toml';

const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return '';
    throw err;
  }
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Same rename-over-temp the ssh path uses: readers never see a half-written settings file. */
async function writeAtomic(file: string, body: string, mode: number): Promise<void> {
  const tmp = `${file}.termhub-new`;
  await writeFile(tmp, body, { encoding: 'utf8', mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

/** Turns a filesystem error into an RpcFailure the server shows as-is; the path names what could not be written. */
function fsFailure(err: unknown, rel: string): RpcFailure {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new RpcFailure('eperm', `sem permissão em ~/${rel}`, rel);
  return new RpcFailure('failed', `não foi possível escrever ~/${rel}: ${err instanceof Error ? err.message : String(err)}`, rel);
}

export async function install(params: RpcParams<'hooks.install'>, home = os.homedir()): Promise<RpcResult<'hooks.install'>> {
  const scriptPath = path.join(home, HOOK_SCRIPT_REL);
  const claudeFile = path.join(home, CLAUDE_SETTINGS_REL);
  const codexFile = path.join(home, CODEX_CONFIG_REL);

  const claudeSettings = await readOrEmpty(claudeFile);
  let mergedClaude: string;
  try {
    mergedClaude = mergeClaudeSettings(claudeSettings, scriptPath);
  } catch (err) {
    // Not a JSON object (or not JSON at all): refuse rather than clobber what the user has there.
    throw new RpcFailure('failed', err instanceof SyntaxError ? '~/.claude/settings.json não é JSON válido' : err instanceof Error ? err.message : String(err), CLAUDE_SETTINGS_REL);
  }
  const hasCodex = await isDir(path.join(home, CODEX_DIR_REL));
  const mergedCodex = hasCodex ? mergeCodexConfig(await readOrEmpty(codexFile), scriptPath) : null;

  let current = HOOK_SCRIPT_REL;
  try {
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await mkdir(path.dirname(claudeFile), { recursive: true });
    current = HOOK_ENV_REL;
    await writeAtomic(path.join(home, HOOK_ENV_REL), hookEnvFile(params.hooks_url, params.token), 0o600);
    current = HOOK_SCRIPT_REL;
    await writeAtomic(scriptPath, HOOK_SCRIPT, 0o755);
    current = CLAUDE_SETTINGS_REL;
    await writeAtomic(claudeFile, mergedClaude, 0o644);
    if (mergedCodex !== null) {
      current = CODEX_CONFIG_REL;
      await writeAtomic(codexFile, mergedCodex, 0o644);
    }
  } catch (err) {
    throw fsFailure(err, current);
  }
  return { home, claude: 'installed', codex: mergedCodex !== null ? 'installed' : 'skipped' };
}

export async function uninstall(_params: RpcParams<'hooks.uninstall'>, home = os.homedir()): Promise<RpcResult<'hooks.uninstall'>> {
  const claudeFile = path.join(home, CLAUDE_SETTINGS_REL);
  const codexFile = path.join(home, CODEX_CONFIG_REL);

  const claudeSettings = await readOrEmpty(claudeFile);
  let stripped: string | null = null;
  try {
    stripped = claudeSettings.trim() ? stripClaudeSettings(claudeSettings) : null;
  } catch {
    stripped = null; // unreadable JSON: leave the file alone
  }
  const codexConfig = (await isDir(path.join(home, CODEX_DIR_REL))) ? await readOrEmpty(codexFile) : '';

  let current = HOOK_SCRIPT_REL;
  try {
    await rm(path.join(home, HOOK_SCRIPT_REL), { force: true });
    current = HOOK_ENV_REL;
    await rm(path.join(home, HOOK_ENV_REL), { force: true });
    if (stripped !== null && stripped !== claudeSettings) {
      current = CLAUDE_SETTINGS_REL;
      await writeAtomic(claudeFile, stripped, 0o644);
    }
    if (codexConfig.includes(HOOK_MARK)) {
      current = CODEX_CONFIG_REL;
      await writeAtomic(codexFile, stripCodexConfig(codexConfig), 0o644);
    }
  } catch (err) {
    throw fsFailure(err, current);
  }
  return { removed: true };
}
