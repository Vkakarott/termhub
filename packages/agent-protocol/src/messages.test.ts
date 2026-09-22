import { describe, expect, it } from 'vitest';
import { agentMessage, claudeOpenParams, helloMessage, ptyOpenParams, serverMessage, PROTOCOL_VERSION } from './messages.js';

const hello = { type: 'hello', protocol: PROTOCOL_VERSION, agent_version: '0.1.0', os: 'macos', arch: 'arm64', hostname: 'mini', tmux: true, tools: ['claude', 'gh'] };

const claudeParams = { session_id: 'sess-1', resume: false, config_dir: null, mcp_url: 'http://127.0.0.1:9000/mcp', token: 'tok-abc' };

describe('control messages', () => {
  // `hello` has no `capabilities` field — this is exactly what every agent already in the
  // field sends today, before this task existed. It must still parse, and it must default to
  // "no capabilities" rather than fail or come back `undefined`.
  it('accepts a valid hello (old agent, no capabilities field) and defaults capabilities to []', () =>
    expect(helloMessage.parse(hello)).toEqual({ ...hello, capabilities: [] }));
  it('rejects hello with an unknown os', () => expect(helloMessage.safeParse({ ...hello, os: 'windows' }).success).toBe(false));
  it('caps hostname length', () => expect(helloMessage.safeParse({ ...hello, hostname: 'x'.repeat(300) }).success).toBe(false));
  it('accepts a hello that declares the claude capability', () =>
    expect(helloMessage.parse({ ...hello, capabilities: ['claude'] }).capabilities).toEqual(['claude']));
  it('parses agent messages by type', () => {
    expect(agentMessage.parse({ type: 'rpc_result', id: 'r1', ok: true, result: { sessions: [] } }).type).toBe('rpc_result');
    expect(agentMessage.parse({ type: 'rpc_result', id: 'r1', ok: false, error: { code: 'eperm', message: 'no', path: '/x' } }).type).toBe('rpc_result');
    expect(agentMessage.parse({ type: 'opened', ch: 3 }).type).toBe('opened');
    expect(agentMessage.parse({ type: 'closed', ch: 3, code: 0 }).type).toBe('closed');
    expect(agentMessage.safeParse({ type: 'rpc', id: 'x', method: 'tmux.list', params: {} }).success).toBe(false);
  });
  it('parses server messages by type', () => {
    expect(serverMessage.parse({ type: 'rpc', id: 'r1', method: 'tmux.list', params: {} }).type).toBe('rpc');
    expect(serverMessage.parse({ type: 'open', ch: 1, kind: 'pty', params: { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 } }).type).toBe('open');
    expect(serverMessage.parse({ type: 'resize', ch: 1, cols: 100, rows: 30 }).type).toBe('resize');
    expect(serverMessage.parse({ type: 'close', ch: 1 }).type).toBe('close');
    expect(serverMessage.safeParse({ type: 'open', ch: 0, kind: 'pty', params: { session: 'a', cwd: '/', cols: 1, rows: 1 } }).success).toBe(false);
  });

  describe('the claude channel kind', () => {
    it('parses a well-formed open with kind: claude, keeping the params types', () => {
      const msg = serverMessage.parse({ type: 'open', ch: 1, kind: 'claude', params: claudeParams });
      if (msg.type !== 'open' || msg.kind !== 'claude') throw new Error('expected an open/claude message');
      expect(claudeOpenParams.parse(msg.params)).toEqual(claudeParams);
    });
    it('still parses kind: pty exactly as before', () => {
      const params = { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 };
      const msg = serverMessage.parse({ type: 'open', ch: 1, kind: 'pty', params });
      if (msg.type !== 'open' || msg.kind !== 'pty') throw new Error('expected an open/pty message');
      expect(ptyOpenParams.parse(msg.params)).toEqual(params);
    });
    it('rejects an unknown open kind', () =>
      expect(serverMessage.safeParse({ type: 'open', ch: 1, kind: 'ssh', params: claudeParams }).success).toBe(false));
    it('rejects kind: pty paired with claude-shaped params, and the reverse', () => {
      expect(serverMessage.safeParse({ type: 'open', ch: 1, kind: 'pty', params: claudeParams }).success).toBe(false);
      expect(serverMessage.safeParse({ type: 'open', ch: 1, kind: 'claude', params: { session: 'a', cwd: '/tmp', cols: 80, rows: 24 } }).success).toBe(false);
    });
    it('accepts config_dir: null (the machine default account)', () =>
      expect(claudeOpenParams.safeParse({ ...claudeParams, config_dir: null }).success).toBe(true));
    it('accepts config_dir as a path', () =>
      expect(claudeOpenParams.safeParse({ ...claudeParams, config_dir: '/home/u/.claude-work' }).success).toBe(true));
  });

  describe('closed reason (ruling R1)', () => {
    it('parses closed with no reason, as every pty channel sends', () =>
      expect(agentMessage.parse({ type: 'closed', ch: 3, code: 0 }).type).toBe('closed'));
    it('parses closed with a known reason', () =>
      expect(agentMessage.parse({ type: 'closed', ch: 3, code: 1, reason: 'cli_missing' })).toMatchObject({ reason: 'cli_missing' }));
    it('parses closed with the reason the server self-heals from', () =>
      expect(agentMessage.parse({ type: 'closed', ch: 3, code: 1, reason: 'missing_session' })).toMatchObject({ reason: 'missing_session' }));
    it('parses closed with the reason that has an instruction attached, so it can reach the screen', () =>
      // A `claude` on the user's own machine that refuses our flags: the sentence for it ("update
      // claude on that machine") only ever reaches the person if this label survives the wire.
      expect(agentMessage.parse({ type: 'closed', ch: 3, code: 1, reason: 'cli_rejected' })).toMatchObject({ reason: 'cli_rejected' }));
    it('rejects closed with an unknown reason', () =>
      expect(agentMessage.safeParse({ type: 'closed', ch: 3, code: 1, reason: 'oops' }).success).toBe(false));
  });
});
