import { describe, expect, it } from 'vitest';
import { agentMessage, helloMessage, serverMessage, PROTOCOL_VERSION } from './messages.js';

const hello = { type: 'hello', protocol: PROTOCOL_VERSION, agent_version: '0.1.0', os: 'macos', arch: 'arm64', hostname: 'mini', tmux: true, tools: ['claude', 'gh'] };

describe('control messages', () => {
  it('accepts a valid hello', () => expect(helloMessage.parse(hello)).toEqual(hello));
  it('rejects hello with an unknown os', () => expect(helloMessage.safeParse({ ...hello, os: 'windows' }).success).toBe(false));
  it('caps hostname length', () => expect(helloMessage.safeParse({ ...hello, hostname: 'x'.repeat(300) }).success).toBe(false));
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
});
