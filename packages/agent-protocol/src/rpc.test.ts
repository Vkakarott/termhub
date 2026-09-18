import { describe, expect, it } from 'vitest';
import { RPC, RPC_METHODS, rpcErrorSchema } from './rpc.js';

describe('rpc catalog', () => {
  it('lists the v1 methods', () => {
    expect([...RPC_METHODS].sort()).toEqual(['ai.credential', 'file.paste', 'fs.list', 'fs.mkdir', 'hw.probe', 'tmux.capture', 'tmux.kill', 'tmux.list', 'tools.detect']);
  });
  it('validates tmux session names', () => {
    expect(RPC['tmux.kill'].params.safeParse({ session: 'th-abc_1' }).success).toBe(true);
    expect(RPC['tmux.kill'].params.safeParse({ session: 'bad name' }).success).toBe(false);
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 6000 }).success).toBe(false);
  });
  it('validates paths for fs.list', () => {
    expect(RPC['fs.list'].params.safeParse({ path: '~/proj' }).success).toBe(true);
    expect(RPC['fs.list'].params.safeParse({ path: 'relative' }).success).toBe(false);
    expect(RPC['fs.list'].params.safeParse({ path: '/a\nb' }).success).toBe(false);
  });
  it('fs.mkdir takes an optional recursive flag', () => {
    expect(RPC['fs.mkdir'].params.safeParse({ parent: '/a', name: 'b' }).success).toBe(true);
    expect(RPC['fs.mkdir'].params.safeParse({ parent: '/a', name: 'b', recursive: true }).success).toBe(true);
    expect(RPC['fs.mkdir'].params.safeParse({ parent: '/a', name: 'b', recursive: 'yes' }).success).toBe(false);
    expect(RPC['fs.mkdir'].params.safeParse({ parent: '/a', name: 'b/c' }).success).toBe(false);
  });
  it('bounds file.paste', () => {
    expect(RPC['file.paste'].params.safeParse({ name: 'paste-1.png', data_b64: 'AAAA' }).success).toBe(true);
    expect(RPC['file.paste'].params.safeParse({ name: '../x', data_b64: 'AAAA' }).success).toBe(false);
    expect(RPC['file.paste'].timeoutMs).toBe(60_000);
    expect(RPC['hw.probe'].timeoutMs).toBe(15_000);
    expect(RPC['tmux.list'].timeoutMs).toBe(8_000);
    expect(RPC['ai.credential'].timeoutMs).toBe(10_000); // same as the ssh path's credential read
  });
  it('shapes rpc errors', () => {
    expect(rpcErrorSchema.parse({ code: 'eperm', message: 'x', path: '/v' }).code).toBe('eperm');
    expect(rpcErrorSchema.safeParse({ code: 'boom', message: 'x' }).success).toBe(false);
  });
});
