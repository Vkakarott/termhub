import fs from 'node:fs';

/**
 * Removes a test's temporary directory (a sandbox HOME, a tmux dir). Tests that start tmux kill its
 * server and move on, but `kill-server` returns before the panes' shells exit, and an exiting shell
 * writes its history into $HOME: on a loaded CI runner that lands mid-removal and `rmSync` fails
 * with ENOTEMPTY (main runs 36670972479 and 36671373886). So it retries with backoff, and a directory
 * still being written to after that is left behind rather than failing the file: a leftover under
 * the OS temp dir is harmless, while any other error still fails.
 */
export function removeTempDir(dir: string, rm: (path: string, opts?: fs.RmOptions) => void = fs.rmSync): void {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOTEMPTY') throw err;
  }
}
