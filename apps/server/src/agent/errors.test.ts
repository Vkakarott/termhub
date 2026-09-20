import { describe, expect, it } from 'vitest';
import { AgentRpcError, AgentTimeoutError } from './connection.js';
import { AgentOfflineError } from './registry.js';
import { toHttpError, versionAtLeast } from './errors.js';

describe('versionAtLeast', () => {
  it('compares dotted numeric versions component by component', () => {
    expect(versionAtLeast('0.1.4', '0.1.4')).toBe(true);
    expect(versionAtLeast('0.1.10', '0.1.4')).toBe(true);
    expect(versionAtLeast('0.2.0', '0.1.4')).toBe(true);
    expect(versionAtLeast('1.0', '0.9.9')).toBe(true);
    expect(versionAtLeast('0.1.3', '0.1.4')).toBe(false);
    expect(versionAtLeast('0.1', '0.1.4')).toBe(false);
  });
});

describe('toHttpError', () => {
  it('relays a "failed" rpc error with the machine\'s own message as 502', () => {
    const err = toHttpError(new AgentRpcError({ code: 'failed', message: 'não deu' }));
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe('não deu');
  });
});

describe('toHttpError codes', () => {
  it('gives every agent failure a code the audit can be read by', () => {
    expect(toHttpError(new AgentOfflineError('x'))).toMatchObject({ statusCode: 503, code: 'AGENT_OFFLINE' });
    expect(toHttpError(new AgentTimeoutError('x'))).toMatchObject({ statusCode: 504, code: 'AGENT_TIMEOUT' });
    expect(toHttpError(new AgentRpcError({ code: 'eperm', message: 'x' }))).toMatchObject({ statusCode: 403, code: 'MACHINE_EPERM' });
    expect(toHttpError(new AgentRpcError({ code: 'notfound', message: 'x' }))).toMatchObject({ statusCode: 404, code: 'MACHINE_NOT_FOUND' });
    expect(toHttpError(new AgentRpcError({ code: 'no_tmux', message: 'x' }))).toMatchObject({ statusCode: 502, code: 'NO_TMUX' });
    expect(toHttpError(new AgentRpcError({ code: 'invalid', message: 'x' }))).toMatchObject({ statusCode: 400, code: 'MACHINE_INVALID' });
    expect(toHttpError(new AgentRpcError({ code: 'failed', message: 'pasta não existe' }))).toMatchObject({ statusCode: 502, code: 'MACHINE_FAILED', message: 'pasta não existe' });
  });
});
