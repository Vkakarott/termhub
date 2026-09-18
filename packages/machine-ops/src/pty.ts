/** Locale forced on target machines when the SSH session brings none (or a non-UTF-8 one). */
export const UTF8_LOCALE = 'en_US.UTF-8';

export function clampSize(size: { cols?: number; rows?: number }): { cols: number; rows: number } {
  const cols = Math.min(Math.max(Math.floor(size.cols ?? 80), 2), 500);
  const rows = Math.min(Math.max(Math.floor(size.rows ?? 24), 2), 200);
  return { cols, rows };
}

/** Env for a spawned PTY: forces UTF-8 locale + xterm identity if the base env doesn't already have one. */
export function ptyEnv(base: NodeJS.ProcessEnv, shell: string): Record<string, string> {
  return {
    ...base,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: /utf-?8/i.test(base.LANG ?? '') ? (base.LANG as string) : UTF8_LOCALE,
    LC_ALL: /utf-?8/i.test(base.LC_ALL ?? '') ? (base.LC_ALL as string) : UTF8_LOCALE,
    SHELL: shell,
    TERMHUB: '1',
  } as Record<string, string>;
}
