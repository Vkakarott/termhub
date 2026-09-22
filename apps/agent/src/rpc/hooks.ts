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
  mergeCursorHooks,
  stripClaudeSettings,
  stripCodexConfig,
  stripCursorHooks,
} from '@termhub/machine-ops';
import { discoverClaudeDirs } from '../claude-dirs.js';
import { RpcFailure } from '../exec.js';

/**
 * Monitor hooks on this machine, written with node:fs (no shell): the forwarding script under
 * ~/.termhub/bin, its env file (url + token, 0600), our entries in the settings.json of each
 * Claude config dir (~/.claude, plus the accounts' own dirs that exist here) and, when Codex
 * or the Cursor CLI is installed, ~/.codex/config.toml and ~/.cursor/hooks.json. The merge/strip logic is the same the server uses for
 * ssh machines (@termhub/machine-ops), so both paths leave the files identical.
 */

const CODEX_DIR_REL = '.codex';
const CODEX_CONFIG_REL = '.codex/config.toml';
const CURSOR_DIR_REL = '.cursor';
const CURSOR_HOOKS_REL = '.cursor/hooks.json';

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

/**
 * ~/.claude always (created when missing); every other dir only when it exists here. Besides the
 * ones termhub registered, the machine's own config dirs are found here (see claude-dirs.ts), so a
 * person who runs Claude through a CLAUDE_CONFIG_DIR alias is hooked without configuring anything.
 */
async function claudeTargets(dirs: string[] | undefined, home: string): Promise<ClaudeTarget[]> {
  const out: ClaudeTarget[] = [];
  for (const d of claudeConfigDirs([...(dirs ?? []), ...(await discoverClaudeDirs(home))])) {
    const dir = expandHome(d, home);
    if (d !== CLAUDE_DEFAULT_DIR && !(await isDir(dir))) continue;
    out.push({ dir, file: path.join(dir, 'settings.json'), shown: `${d}/settings.json` });
  }
  return out;
}

/** Our entries merged into ~/.cursor/hooks.json, or null when the Cursor CLI is not here. Refuses a file it cannot parse, before anything is written. */
async function mergedCursorHooks(home: string, scriptPath: string): Promise<string | null> {
  if (!(await isDir(path.join(home, CURSOR_DIR_REL)))) return null;
  try {
    return mergeCursorHooks(await readOrEmpty(path.join(home, CURSOR_HOOKS_REL)), scriptPath);
  } catch (err) {
    const message = err instanceof SyntaxError || (err instanceof Error && err.message.includes('não é um objeto JSON')) ? `~/${CURSOR_HOOKS_REL} não é JSON válido` : err instanceof Error ? err.message : String(err);
    throw new RpcFailure('failed', message, CURSOR_HOOKS_REL);
  }
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
  const mergedCursor = await mergedCursorHooks(home, scriptPath);

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
    if (mergedCursor !== null) {
      current = `~/${CURSOR_HOOKS_REL}`;
      await writeAtomic(path.join(home, CURSOR_HOOKS_REL), mergedCursor, 0o644);
    }
  } catch (err) {
    throw fsFailure(err, current);
  }
  return {
    home,
    claude: 'installed',
    codex: mergedCodex !== null ? 'installed' : 'skipped',
    cursor: mergedCursor !== null ? 'installed' : 'skipped',
    claude_dirs: merged.map(({ target }) => target.shown.replace(/\/settings\.json$/, '')),
  };
}

/**
 * Brings this machine's hooks back up to what this agent carries, reusing the url and token already
 * installed here: the forwarding script when the one on disk differs, and our entries wherever they
 * are missing — each Claude config dir, the Cursor CLI's hooks.json, Codex's notify. The agent calls
 * it on startup and on every reconnect, so a config dir or a CLI that showed up after the install
 * starts notifying on its own, and a script from an older agent is replaced. A machine without our
 * hooks is left untouched: installing is the server's call, not ours.
 *
 * Answers the dirs it repaired ("~/.claude-x", "~/.cursor", "~/.codex").
 */
export async function heal(home = os.homedir()): Promise<string[]> {
  const scriptPath = path.join(home, HOOK_SCRIPT_REL);
  const env = await readOrEmpty(path.join(home, HOOK_ENV_REL));
  const script = await readOrEmpty(scriptPath);
  if (!env.trim() || !script) return [];

  // The agent bundles the script, so an agent that updated itself can find an older one here while
  // the entries below already name the events only the new one handles — the script goes first, and
  // only when it really differs (same atomic 0o755 write `install` uses; comparing the content, not
  // a version, is what keeps every later change to the script reaching machines by itself).
  if (script !== HOOK_SCRIPT) await writeAtomic(scriptPath, HOOK_SCRIPT, 0o755);

  return [...(await healClaudeDirs(home, scriptPath)), ...(await healCursor(home, scriptPath)), ...(await healCodex(home, scriptPath))];
}

/** Our entries in the Claude config dirs that lack them; answers the dirs it wrote. */
async function healClaudeDirs(home: string, scriptPath: string): Promise<string[]> {
  const healed: string[] = [];
  for (const dir of await discoverClaudeDirs(home)) {
    const file = path.join(expandHome(dir, home), 'settings.json');
    const current = await readOrEmpty(file);
    let body: string;
    try {
      body = mergeClaudeSettings(current, scriptPath);
    } catch {
      continue; // not a settings file we understand: leave it as the person wrote it
    }
    if (body === current) continue;
    await writeAtomic(file, body, 0o644);
    healed.push(dir);
  }
  return healed;
}

/**
 * Our entries back in ~/.cursor/hooks.json when the Cursor CLI is here and they are missing — it
 * was installed after the hooks, or Cursor rewrote a file its own UI manages. The merge keeps the
 * person's own hooks; a file it cannot parse is left alone.
 */
async function healCursor(home: string, scriptPath: string): Promise<string[]> {
  if (!(await isDir(path.join(home, CURSOR_DIR_REL)))) return [];
  const file = path.join(home, CURSOR_HOOKS_REL);
  const current = await readOrEmpty(file);
  let body: string;
  try {
    body = mergeCursorHooks(current, scriptPath);
  } catch {
    return [];
  }
  if (body === current) return [];
  await writeAtomic(file, body, 0o644);
  return [`~/${CURSOR_DIR_REL}`];
}

/**
 * Our notify in ~/.codex/config.toml only when there is no notify at all: Codex takes a single one,
 * so a notify the person set for something else is theirs to keep — replacing it is the install's
 * call (the machine form), never a silent repair on every agent start.
 */
async function healCodex(home: string, scriptPath: string): Promise<string[]> {
  if (!(await isDir(path.join(home, CODEX_DIR_REL)))) return [];
  const file = path.join(home, CODEX_CONFIG_REL);
  const current = await readOrEmpty(file);
  if (/^\s*notify\s*=/m.test(current)) return [];
  await writeAtomic(file, mergeCodexConfig(current, scriptPath), 0o644);
  return [`~/${CODEX_DIR_REL}`];
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
  const cursorFile = path.join(home, CURSOR_HOOKS_REL);
  const cursorHooks = await readOrEmpty(cursorFile);
  let strippedCursor: string | null = null;
  try {
    strippedCursor = cursorHooks.includes(HOOK_MARK) ? stripCursorHooks(cursorHooks) : null;
  } catch {
    // unreadable JSON: leave the file alone
  }

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
    if (strippedCursor !== null) {
      current = `~/${CURSOR_HOOKS_REL}`;
      await writeAtomic(cursorFile, strippedCursor, 0o644);
    }
  } catch (err) {
    throw fsFailure(err, current);
  }
  return { removed: true };
}
