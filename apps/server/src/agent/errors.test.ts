import { describe, expect, it } from 'vitest';
import { AgentRpcError } from './connection.js';
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
