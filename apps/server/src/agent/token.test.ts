import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_RE, hashAgentToken, newAgentToken } from './token.js';

describe('agent token', () => {
  it('generates thb_ag_ + 43 base64url chars and a sha256 hash', () => {
    const { token, hash } = newAgentToken();
    expect(token).toMatch(AGENT_TOKEN_RE);
    expect(token.length).toBe('thb_ag_'.length + 43);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken(token)).toBe(hash);
  });
  it('never repeats', () => expect(newAgentToken().token).not.toBe(newAgentToken().token));
});
