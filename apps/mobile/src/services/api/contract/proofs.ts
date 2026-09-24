// Copied verbatim from packages/mobile-api/src/proofs.ts @ c6bab0a (feat/mobile-chat-server).
// Replaced by `import … from '@termhub/mobile-api' once that package is on main. Do not edit here.
/** The base + path a signed decision proof is bound to, dropping the query string and any
 * trailing slash on the base — the app and the server must agree byte-for-byte on what was signed. */
export const canonicalHtu = (base: string, path: string) => base.replace(/\/$/, '') + path.split('?')[0];

/** What the device's PIN key signs to approve a pending action: the challenge and the action it
 * applies to, newline-separated, so a proof for one action or challenge can never be replayed for another. */
export const decisionProofMessage = (challenge: string, actionId: string, decision: 'approve') => `${challenge}\n${actionId}\n${decision}`;
