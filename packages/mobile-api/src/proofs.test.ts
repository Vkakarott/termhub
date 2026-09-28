import { describe, expect, it } from 'vitest';
import { canonicalHtu, decisionProofMessage } from './proofs.js';

describe('proof helpers', () => {
  it('builds the htu from the base and the path, dropping the query and a trailing slash', () => {
    expect(canonicalHtu('https://termhub.dev/', '/api/m/v1/chat?project=p1')).toBe('https://termhub.dev/api/m/v1/chat');
  });
  it('the decision message binds challenge, action and the word approve, newline-separated', () => {
    expect(decisionProofMessage('c1', 'a1', 'approve')).toBe('c1\na1\napprove');
  });
  it('a grant is signed with its own word, so an "approve" proof cannot open one', () => {
    expect(decisionProofMessage('c1', 'a1', 'approve_tab')).toBe('c1\na1\napprove_tab');
    expect(decisionProofMessage('c1', 'a1', 'approve_tab')).not.toBe(decisionProofMessage('c1', 'a1', 'approve'));
  });
  it('approve_project signs a different message', () => {
    expect(decisionProofMessage('c1', 'a1', 'approve_project')).toBe('c1\na1\napprove_project');
    expect(decisionProofMessage('c1', 'a1', 'approve_project')).not.toBe(decisionProofMessage('c1', 'a1', 'approve_tab'));
    expect(decisionProofMessage('c1', 'a1', 'approve_project')).not.toBe(decisionProofMessage('c1', 'a1', 'approve'));
  });
  it('the terminal grants sign their own words, different from every other', () => {
    const words = ['approve', 'approve_tab', 'approve_project', 'approve_tab_terminal', 'approve_project_all'] as const;
    expect(decisionProofMessage('c', 'a', 'approve_tab_terminal')).toBe('c\na\napprove_tab_terminal');
    expect(new Set(words.map((w) => decisionProofMessage('c', 'a', w))).size).toBe(words.length);
  });
});
