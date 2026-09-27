import { describe, expect, it } from 'vitest';
import { classifyFailure } from './index.js';

// Both runners read the same CLI's stderr and must reach the same label from it: the container
// turns it into the error the browser shows, and the agent into the `closed` reason the server
// self-heals from (a pruned local history must not end the conversation for ever).
describe('classifyFailure', () => {
  it('classifies the CLI complaining about a missing session, and nothing else', () => {
    expect(classifyFailure('No conversation found with session ID 3f1e9b1e-0000-4000-8000-000000000001')).toBe('missing_session');
    expect(classifyFailure('no conversation found')).toBe('missing_session'); // case-insensitive
    expect(classifyFailure('Error: Invalid session ID: not-a-uuid')).toBe('run_failed');
    expect(classifyFailure('')).toBe('run_failed');
    expect(classifyFailure('Credit balance is too low')).toBe('run_failed');
  });

  it('classifies the CLI rejecting our own flags apart from a run that failed', () => {
    expect(classifyFailure('Error: --session-id can only be used with --continue or --resume\n')).toBe('cli_rejected');
    // Anchored per line: the same complaint after a banner line is still ours.
    expect(classifyFailure('some banner\nError: --output-format needs --verbose\n')).toBe('cli_rejected');
  });

  it('reads a real stderr tail, where the phrase is not at the start', () => {
    expect(classifyFailure('warning: config dir is new\nNo conversation found with session ID abc\n')).toBe('missing_session');
  });

  it('classifies an older CLI that does not know one of our flags as ours to fix', () => {
    // commander's own wording, lowercase: what a CLI without --tools prints before doing any work.
    // The web and the app answer CLI_REJECTED with "Atualize o claude nela", which is the advice.
    expect(classifyFailure("error: unknown option '--tools'\n")).toBe('cli_rejected');
    expect(classifyFailure("banner\nerror: unknown option '--replay-user-messages'\n")).toBe('cli_rejected');
    // Anchored at the start of a line: the phrase inside other text is not the CLI refusing argv.
    expect(classifyFailure('the model said: error: unknown option is a commander message')).toBe('run_failed');
    expect(classifyFailure('error: rate limited')).toBe('run_failed');
    expect(classifyFailure('Error: unknown model foo\n')).toBe('run_failed');
  });
});
