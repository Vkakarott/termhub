// Copied verbatim from packages/mobile-api/src/proofs.test.ts @ c6bab0a (feat/mobile-chat-server), converted from
// vitest to jest globals. Replaced by tests in `@termhub/mobile-api` once that package is on main.
import { canonicalHtu, decisionProofMessage } from './proofs.js';

describe('proof helpers', () => {
  it('builds the htu from the base and the path, dropping the query and a trailing slash', () => {
    expect(canonicalHtu('https://termhub.dev/', '/api/m/v1/chat?project=p1')).toBe('https://termhub.dev/api/m/v1/chat');
  });
  it('the decision message binds challenge, action and the word approve, newline-separated', () => {
    expect(decisionProofMessage('c1', 'a1', 'approve')).toBe('c1\na1\napprove');
  });
});
