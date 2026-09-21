import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { type HomeEntry, claudeDirsFromHome, configDirsFromRc, expandHome } from '@termhub/machine-ops';

/**
 * The Claude config dirs of this machine, found without asking anyone: the `.claude*` dirs of the
 * home that hold Claude Code, plus every CLAUDE_CONFIG_DIR the shell rc files point at (one alias
 * per account is how people keep several logins side by side). The dirs registered in termhub are
 * still honoured; these are added to them, so a machine notifies even with nothing configured.
 */

/** Where a shell keeps the aliases and exports of an interactive session. */
const RC_FILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile', '.config/fish/config.fish'];

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function fileNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The `.claude*` dirs of the home; the cheap name filter keeps us from listing the whole home. */
async function candidateNames(home: string): Promise<string[]> {
  try {
    const list = await readdir(home, { withFileTypes: true });
    return list.filter((d) => d.isDirectory() && d.name.startsWith('.claude')).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Each dir once, as "~/x" or "/abs", and only the ones that are really there. */
export async function discoverClaudeDirs(home: string): Promise<string[]> {
  const entries: HomeEntry[] = [];
  for (const name of await candidateNames(home)) {
    entries.push({ name, files: await fileNames(path.join(home, name)) });
  }
  const dirs = claudeDirsFromHome(entries);

  for (const rc of RC_FILES) {
    for (const dir of configDirsFromRc(await readOrEmpty(path.join(home, rc)))) {
      if (!dirs.includes(dir) && (await isDir(expandHome(dir, home)))) dirs.push(dir);
    }
  }
  return dirs;
}
