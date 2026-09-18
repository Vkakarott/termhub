/** Escapa para uso dentro de aspas simples no shell remoto. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const SESSION_RE = /^[A-Za-z0-9_-]+$/;
export function assertSessionName(name: string): void {
  if (!SESSION_RE.test(name)) throw new Error(`Nome de sessão tmux inválido: ${name}`);
}

/**
 * Non-interactive SSH commands get the sshd default PATH (on macOS just /usr/bin:/bin:...),
 * which misses Homebrew and ~/.local/bin. Every remote command is prefixed with this.
 */
export const REMOTE_PATH_PREFIX = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
