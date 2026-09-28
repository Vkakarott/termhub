/**
 * A floor, not a scanner (spec 2026-09-27 failure lessons §9): a small list of token shapes that must
 * never end up in a lesson (a repository file or a project note, both potentially shared and both
 * outside the product's own secret storage). Checked against every free-text field a lesson writer
 * takes, before the text is written anywhere.
 */
const SECRET_RE = /thb_pat_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9-]{16,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * True when any of `parts` contains something that looks like a token or private key.
 */
export function containsSecret(parts: string[]): boolean {
  return parts.some((p) => SECRET_RE.test(p));
}
