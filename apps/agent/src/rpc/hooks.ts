import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import {
  CLAUDE_DEFAULT_DIR,
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
import { RpcFailure } from '../exec.js';

/**
 * Monitor hooks on this machine, written with node:fs (no shell): the forwarding script under
 * ~/.termhub/bin, its env file (url + token, 0600), our entries in the settings.json of each
 * Claude config dir (~/.claude, plus the accounts' own dirs that exist here) and, when Codex
 * is installed, ~/.codex/config.toml. The merge/strip logic is the same the server uses for
 * ssh machines (@termhub/machine-ops), so both paths leave the files identical.
 */

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

/** "~/x" → "x" (the RpcFailure path is home-relative when it can be); absolute paths stay. */
const relPath = (shown: string) => (shown.startsWith('~/') ? shown.slice(2) : shown);

/** Turns a filesystem error into an RpcFailure the server shows as-is; `shown` names what could not be written ("~/x" or "/abs"). */
function fsFailure(err: unknown, shown: string): RpcFailure {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new RpcFailure('eperm', `sem permissão em ${shown}`, relPath(shown));
  return new RpcFailure('failed', `não foi possível escrever ${shown}: ${err instanceof Error ? err.message : String(err)}`, relPath(shown));
}

/** A Claude config dir to hook: how it is shown ("~/.claude") and its settings.json here. */
interface ClaudeTarget {
  dir: string;
  file: string;
  shown: string;
}

/** ~/.claude always (created when missing); an account's own dir only when it exists here. */
async function claudeTargets(dirs: string[] | undefined, home: string): Promise<ClaudeTarget[]> {
  const out: ClaudeTarget[] = [];
  for (const d of claudeConfigDirs(dirs ?? [])) {
    const dir = expandHome(d, home);
    if (d !== CLAUDE_DEFAULT_DIR && !(await isDir(dir))) continue;
    out.push({ dir, file: path.join(dir, 'settings.json'), shown: `${d}/settings.json` });
  }
  return out;
}

export async function install(params: RpcParams<'hooks.install'>, home = os.homedir()): Promise<RpcResult<'hooks.install'>> {
  const scriptPath = path.join(home, HOOK_SCRIPT_REL);
  const codexFile = path.join(home, CODEX_CONFIG_REL);

  // every settings file is merged before anything is written: one bad file leaves the machine as it was
  const targets = await claudeTargets(params.claude_dirs, home);
  const merged: { target: ClaudeTarget; body: string }[] = [];
  for (const target of targets) {
    try {
      merged.push({ target, body: mergeClaudeSettings(await readOrEmpty(target.file), scriptPath) });
    } catch (err) {
      // Not a JSON object (or not JSON at all): refuse rather than clobber what the user has there.
      const message = err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `${target.shown} não é JSON válido` : err instanceof Error ? err.message : String(err);
      throw new RpcFailure('failed', message, relPath(target.shown));
    }
  }
  const hasCodex = await isDir(path.join(home, CODEX_DIR_REL));
  const mergedCodex = hasCodex ? mergeCodexConfig(await readOrEmpty(codexFile), scriptPath) : null;

  let current = `~/${HOOK_SCRIPT_REL}`;
  try {
    await mkdir(path.dirname(scriptPath), { recursive: true });
    current = `~/${HOOK_ENV_REL}`;
    await writeAtomic(path.join(home, HOOK_ENV_REL), hookEnvFile(params.hooks_url, params.token), 0o600);
    current = `~/${HOOK_SCRIPT_REL}`;
    await writeAtomic(scriptPath, HOOK_SCRIPT, 0o755);
    for (const { target, body } of merged) {
      current = target.shown;
      await mkdir(target.dir, { recursive: true });
      await writeAtomic(target.file, body, 0o644);
    }
    if (mergedCodex !== null) {
      current = `~/${CODEX_CONFIG_REL}`;
      await writeAtomic(codexFile, mergedCodex, 0o644);
    }
  } catch (err) {
    throw fsFailure(err, current);
  }
  return {
    home,
    claude: 'installed',
    codex: mergedCodex !== null ? 'installed' : 'skipped',
    claude_dirs: merged.map(({ target }) => target.shown.replace(/\/settings\.json$/, '')),
  };
}

export async function uninstall(params: RpcParams<'hooks.uninstall'>, home = os.homedir()): Promise<RpcResult<'hooks.uninstall'>> {
  const codexFile = path.join(home, CODEX_CONFIG_REL);

  const stripped: { target: ClaudeTarget; body: string }[] = [];
  for (const target of await claudeTargets(params.claude_dirs, home)) {
    const current = await readOrEmpty(target.file);
    try {
      const body = current.trim() ? stripClaudeSettings(current) : current;
      if (body !== current) stripped.push({ target, body });
    } catch {
      // unreadable JSON: leave the file alone
    }
  }
  const codexConfig = (await isDir(path.join(home, CODEX_DIR_REL))) ? await readOrEmpty(codexFile) : '';

  let current = `~/${HOOK_SCRIPT_REL}`;
  try {
    await rm(path.join(home, HOOK_SCRIPT_REL), { force: true });
    current = `~/${HOOK_ENV_REL}`;
    await rm(path.join(home, HOOK_ENV_REL), { force: true });
    for (const { target, body } of stripped) {
      current = target.shown;
      await writeAtomic(target.file, body, 0o644);
    }
    if (codexConfig.includes(HOOK_MARK)) {
      current = `~/${CODEX_CONFIG_REL}`;
      await writeAtomic(codexFile, stripCodexConfig(codexConfig), 0o644);
    }
  } catch (err) {
    throw fsFailure(err, current);
  }
  return { removed: true };
}
