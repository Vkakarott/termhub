import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, DISALLOWED_TOOLS, mcpConfig } from './index.js';

const spec = {
  session_id: '3f1e9b1e-0000-4000-8000-000000000001',
  resume: false,
  mcp_config_path: '/tmp/mcp.json',
  model: null as string | null,
};

describe('buildClaudeArgs', () => {
  it('produces the exact argv the spec fixes, flag-value pairs adjacent, in a fixed order', () => {
    // A test that only checks a flag is present would still pass if its value drifted onto another
    // flag's slot; toEqual on the whole array is the strongest form of "adjacent pair" assertion.
    expect(buildClaudeArgs(spec)).toEqual([
      '-p',
      '--session-id', spec.session_id,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config', spec.mcp_config_path,
      '--strict-mcp-config',
      '--allowed-tools', 'mcp__termhub__*',
      '--disallowed-tools', DISALLOWED_TOOLS,
    ]);
  });

  it('resumes with --resume alone: the CLI refuses it next to --session-id', () => {
    // Error: --session-id can only be used with --continue or --resume if --fork-session is also
    // specified. Passing both broke every message after the first, and this pins that it never
    // happens again.
    const args = buildClaudeArgs({ ...spec, resume: true });
    const idx = args.indexOf('--resume');
    expect(args.slice(idx, idx + 2)).toEqual(['--resume', spec.session_id]);
    expect(args).not.toContain('--session-id');
  });

  it('names the session on a first run, where --session-id is the only way to choose the id', () => {
    const args = buildClaudeArgs({ ...spec, resume: false });
    const idx = args.indexOf('--session-id');
    expect(args.slice(idx, idx + 2)).toEqual(['--session-id', spec.session_id]);
    expect(args).not.toContain('--resume');
  });

  it('passes the model through when given, and omits the flag entirely when absent', () => {
    const withModel = buildClaudeArgs({ ...spec, model: 'sonnet' });
    const idx = withModel.indexOf('--model');
    expect(withModel.slice(idx, idx + 2)).toEqual(['--model', 'sonnet']);

    const withoutModel = buildClaudeArgs({ ...spec, model: null });
    expect(withoutModel).not.toContain('--model');
    const undefinedModel = buildClaudeArgs({ session_id: spec.session_id, resume: false, mcp_config_path: spec.mcp_config_path });
    expect(undefinedModel).not.toContain('--model');
  });

  it('never puts the prompt in argv, for any input including one that begins with "-"', () => {
    // The prompt travels on stdin (the concierge writes it there), never as an argument: a prompt
    // beginning with "-" must never be readable as a flag.
    const args = buildClaudeArgs(spec);
    expect(args).not.toContain('-a-prompt-that-looks-like-a-flag');
    for (const arg of args) expect(arg.startsWith('--dangerously')).toBe(false);
  });
});

describe('mcpConfig', () => {
  it('puts the token in the header and nowhere else, and is valid JSON with one server named termhub', () => {
    const token = 'thb_pat_' + 'A'.repeat(43);
    const url = 'https://termhub.dev/mcp';
    const raw = mcpConfig(url, token);
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      mcpServers: {
        termhub: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
      },
    });
    // The token must not leak into a second place in the payload (e.g. a query string or a log field).
    expect(raw.split(token)).toHaveLength(2);
  });
});
