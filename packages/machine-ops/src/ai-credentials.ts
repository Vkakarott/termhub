import { shellQuote } from './shell.js';

export type AiProvider = 'claude' | 'chatgpt' | 'gemini' | 'antigravity';

/** POSIX sh that prints the CLI credential; $D is the provider config dir (already set by the caller). */
export function credentialScript(provider: AiProvider): string {
  switch (provider) {
    case 'claude':
      // file first (Linux, and macOS when keychain is disabled); then the macOS keychain
      return [
        `if [ -f "$D/.credentials.json" ]; then cat "$D/.credentials.json"`,
        `elif [ "$(uname -s)" = Darwin ]; then security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true`,
        `fi`,
      ].join('; ');
    case 'chatgpt':
      return `if [ -f "$D/auth.json" ]; then cat "$D/auth.json"; fi`;
    case 'gemini':
      return `if [ -f "$D/oauth_creds.json" ]; then cat "$D/oauth_creds.json"; fi`;
    case 'antigravity':
      return `if [ -f "$D/antigravity-cli/antigravity-oauth-token" ]; then cat "$D/antigravity-cli/antigravity-oauth-token"; fi`;
  }
}

/** Default CLI config dir (relative to $HOME) per provider. */
export const DEFAULT_CONFIG_DIRS: Record<AiProvider, string> = { claude: '.claude', chatgpt: '.codex', gemini: '.gemini', antigravity: '.gemini' };

/**
 * "~" and "~/x" are expanded on the target machine, never here.
 * Returns the sh prefix that sets $D to the provider's config dir.
 */
export function configDirPrefix(configDir: string | null, defaultDir: string): string {
  const raw = (configDir ?? '').trim();
  if (!raw) return `D="$HOME/${defaultDir}"`;
  if (raw.includes('\0') || raw.includes('\n')) throw new Error('Invalid config dir');
  return `P=${shellQuote(raw)}; case "$P" in "~") P=$HOME;; "~/"*) P="$HOME/\${P#\\~/}";; esac; D="$P"`;
}
